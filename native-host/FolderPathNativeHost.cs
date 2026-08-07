using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Win32;

internal static class FolderPathNativeHost
{
    // Kept in step with the version in manifest.json; the installer verifies that the host it
    // just built reports this value.
    private const string HostVersion = "1.3.27";

    private const int MaximumMessageBytes = 1024 * 1024;
    private const int Windows11ExplorerTabsBuild = 22621;
    private const int ExplorerActivationDelayMs = 400;
    private const int ExplorerFocusTimeoutMs = 3000;
    private const int ExplorerRestoreTimeoutMs = 3000;
    private const int ExplorerRestoreSettleDelayMs = 700;
    private const int InputFocusTimeoutMs = 5000;
    private const int NewTabSettleDelayMs = 400;
    private const int NewTabAppearsTimeoutMs = 5000;
    private const int NavigationVerifyTimeoutMs = 3000;
    private const int AddressBarAttempts = 2;
    private const int AddressBarFocusTimeoutMs = 1500;
    private const int AddressBarReadyDelayMs = 500;
    private const int PasteAttempts = 3;
    private const int PasteVerifyTimeoutMs = 2000;
    private const int PollRetryMs = 100;
    private const int NewWindowTimeoutMs = 5000;
    private const int ClipboardReadyDelayMs = 150;
    private const int NavigationStartDelayMs = 1200;
    private const int MessageTimeoutMs = 1000;

    private const string ExplorerWindowClass = "CabinetWClass";
    private const string AddressBarEditClass = "Edit";
    private const int ShowWindowRestore = 9;
    private const uint GetAncestorRoot = 2;
    private const uint MessageGetText = 0x000D;
    private const uint MessageSetText = 0x000C;
    private const uint SendMessageAbortIfHung = 0x0002;

    private static readonly StringBuilder Diagnostics = new StringBuilder();

    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct GuiThreadInfo
    {
        public int Size;
        public int Flags;
        public IntPtr ActiveWindow;
        public IntPtr FocusWindow;
        public IntPtr CaptureWindow;
        public IntPtr MenuOwnerWindow;
        public IntPtr MoveSizeWindow;
        public IntPtr CaretWindow;
        public WindowRect CaretRect;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder className, int capacity);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attachingThread, uint attachedToThread, bool attach);

    [DllImport("user32.dll")]
    private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wordParameter,
        StringBuilder longParameter, uint flags, uint timeout, out IntPtr result);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wordParameter,
        string longParameter, uint flags, uint timeout, out IntPtr result);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [STAThread]
    public static void Main(string[] arguments)
    {
        // The installer, and anyone checking an installation by hand, needs a way to tell which
        // build actually sits in %LOCALAPPDATA%: the extension files can be updated without
        // rebuilding the host, and then none of the changes here are in effect.
        if (arguments != null && arguments.Length > 0
            && string.Equals(arguments[0], "-version", StringComparison.OrdinalIgnoreCase))
        {
            Console.Out.WriteLine(HostVersion);
            return;
        }

        using (Stream input = Console.OpenStandardInput())
        using (Stream output = Console.OpenStandardOutput())
        {
            string path = null;
            try
            {
                Log("host version " + HostVersion);
                byte[] lengthBytes = ReadExactly(input, 4);
                int length = BitConverter.ToInt32(lengthBytes, 0);
                if (length <= 0 || length > MaximumMessageBytes) throw new InvalidDataException("Invalid message size.");

                string json = Encoding.UTF8.GetString(ReadExactly(input, length));
                var serializer = new JavaScriptSerializer();
                var request = serializer.Deserialize<Dictionary<string, object>>(json);
                path = request.ContainsKey("path") ? Convert.ToString(request["path"]) : string.Empty;
                if (string.IsNullOrWhiteSpace(path) || path.IndexOf('\0') >= 0) throw new InvalidDataException("Invalid folder path.");

                Log("request path=" + path);
                bool openedInTab = TryOpenInExistingExplorerTab(path);
                if (!openedInTab)
                {
                    Log("fallback: opening a new window");
                    OpenInNewExplorerWindow(path);
                }
                Log("done openedInTab=" + openedInTab);
                // The extension compares this against its own version: updating the extension
                // files does not rebuild this host, and a stale host silently behaves like the
                // build it was compiled from.
                Write(output, "{\"ok\":true,\"openedInTab\":" + openedInTab.ToString().ToLowerInvariant()
                    + ",\"version\":\"" + HostVersion + "\"}");
            }
            catch (Exception exception)
            {
                Log("error: " + exception.Message);
                var serializer = new JavaScriptSerializer();
                Write(output, serializer.Serialize(new { ok = false, error = exception.Message, version = HostVersion }));
            }
            finally
            {
                WriteDiagnostics();
            }
        }
    }

    private static bool TryOpenInExistingExplorerTab(string path)
    {
        int build = GetWindowsBuildNumber();
        if (build < Windows11ExplorerTabsBuild)
        {
            Log("build " + build + " has no Explorer tabs");
            return false;
        }

        IntPtr explorerWindow = FindExplorerWindow();
        if (explorerWindow == IntPtr.Zero)
        {
            Log("no Explorer window found");
            return false;
        }
        Log("target window=" + explorerWindow.ToInt64() + " minimized=" + IsIconic(explorerWindow));

        // A minimized window has no keyboard focus, so keystrokes used to reach nothing. Restore
        // the window and confirm each following step instead of trusting fixed delays: after a
        // restore Explorer needs noticeably longer to build its tab strip and address bar.
        if (!RestoreExplorerWindow(explorerWindow)) return false;
        if (!ActivateExplorerWindow(explorerWindow))
        {
            Log("could not bring the window to the foreground");
            return false;
        }
        Thread.Sleep(ExplorerActivationDelayMs);
        if (!WaitForExplorerInputFocus(explorerWindow, "before opening a tab")) return false;

        // Snapshot the open tabs first so the one Ctrl+T creates can be told apart afterwards.
        List<object> tabsBefore = GetShellTabs();
        List<IntPtr> identitiesBefore = GetComIdentities(tabsBefore);

        if (!SendToExplorer(explorerWindow, "^t")) return false;
        bool inputReady = WaitForExplorerInputFocus(explorerWindow, "after opening a tab");
        Thread.Sleep(NewTabSettleDelayMs);

        // Navigating the new tab through the shell needs no keyboard focus at all, which is what
        // kept failing right after a restore, so it runs even when the focus never settled. The
        // keystroke route below stays as a fallback.
        bool navigated = TryNavigateNewTab(explorerWindow, identitiesBefore, path);
        GC.KeepAlive(tabsBefore);
        if (navigated)
        {
            Log("navigation started through the shell");
            return true;
        }
        if (!inputReady)
        {
            CloseUnusedTab(explorerWindow);
            return false;
        }

        IntPtr addressBar = FocusAddressBar(explorerWindow);
        bool filled = addressBar != IntPtr.Zero
            ? FillAddressBar(explorerWindow, addressBar, path)
            : FillAddressBarBlind(explorerWindow, path);
        if (!filled)
        {
            CloseUnusedTab(explorerWindow);
            return false;
        }

        if (!SendToExplorer(explorerWindow, "{ENTER}")) return false;
        Thread.Sleep(NavigationStartDelayMs);
        Log("navigation started");
        return true;
    }

    // Every Explorer tab is its own shell browser, so the tab Ctrl+T just created can be found
    // by comparing against the snapshot taken before the keystroke and then told to navigate.
    // This replaces Ctrl+L, the clipboard paste and Enter, none of which survive an Explorer
    // that is still initialising after being restored from the taskbar.
    private static bool TryNavigateNewTab(IntPtr explorerWindow, List<IntPtr> identitiesBefore, string path)
    {
        object newTab = null;
        WaitFor(NewTabAppearsTimeoutMs, delegate
        {
            List<object> tabs = GetShellTabs();
            for (int index = 0; index < tabs.Count; index++)
            {
                if (GetShellTabWindow(tabs[index]) != explorerWindow) continue;
                if (identitiesBefore.Contains(GetComIdentity(tabs[index]))) continue;
                newTab = tabs[index];
                return true;
            }
            return false;
        });

        if (newTab == null)
        {
            Log("the new tab did not appear in the shell window list");
            return false;
        }

        try
        {
            InvokeMember(newTab, "Navigate2", BindingFlags.InvokeMethod, path);
        }
        catch (Exception exception)
        {
            Log("shell navigation failed: " + exception.Message);
            return false;
        }

        // A slow network share can still be loading, so a timeout here is not a failure.
        bool arrived = WaitFor(NavigationVerifyTimeoutMs, delegate
        {
            return PathsMatch(GetShellTabPath(newTab), path);
        });
        Log("shell navigation confirmed=" + arrived);
        return true;
    }

    private static List<object> GetShellTabs()
    {
        var tabs = new List<object>();
        try
        {
            Type shellType = Type.GetTypeFromProgID("Shell.Application");
            if (shellType == null) return tabs;

            object shell = Activator.CreateInstance(shellType);
            object windows = InvokeMember(shell, "Windows", BindingFlags.InvokeMethod);
            if (windows == null) return tabs;

            int count = Convert.ToInt32(InvokeMember(windows, "Count", BindingFlags.GetProperty));
            for (int index = 0; index < count; index++)
            {
                try
                {
                    object tab = InvokeMember(windows, "Item", BindingFlags.InvokeMethod, index);
                    if (tab != null) tabs.Add(tab);
                }
                catch
                {
                    // A window can close while the collection is being walked.
                }
            }
        }
        catch (Exception exception)
        {
            Log("shell window list unavailable: " + exception.Message);
        }
        return tabs;
    }

    private static IntPtr GetShellTabWindow(object tab)
    {
        try
        {
            return new IntPtr(Convert.ToInt64(InvokeMember(tab, "HWND", BindingFlags.GetProperty)));
        }
        catch
        {
            return IntPtr.Zero;
        }
    }

    private static string GetShellTabPath(object tab)
    {
        try
        {
            object document = InvokeMember(tab, "Document", BindingFlags.GetProperty);
            object folder = InvokeMember(document, "Folder", BindingFlags.GetProperty);
            object self = InvokeMember(folder, "Self", BindingFlags.GetProperty);
            return Convert.ToString(InvokeMember(self, "Path", BindingFlags.GetProperty));
        }
        catch
        {
            return string.Empty;
        }
    }

    private static bool PathsMatch(string left, string right)
    {
        return string.Equals(left.TrimEnd('\\'), right.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    }

    private static object InvokeMember(object target, string member, BindingFlags flags, params object[] arguments)
    {
        return target.GetType().InvokeMember(member, flags, null, target, arguments);
    }

    private static List<IntPtr> GetComIdentities(List<object> items)
    {
        var identities = new List<IntPtr>();
        for (int index = 0; index < items.Count; index++)
        {
            identities.Add(GetComIdentity(items[index]));
        }
        return identities;
    }

    // The caller keeps the wrappers alive, so releasing the reference this call adds still leaves
    // the pointer valid and unique for as long as it is compared.
    private static IntPtr GetComIdentity(object item)
    {
        IntPtr unknown = IntPtr.Zero;
        try
        {
            unknown = Marshal.GetIUnknownForObject(item);
            return unknown;
        }
        catch
        {
            return IntPtr.Zero;
        }
        finally
        {
            if (unknown != IntPtr.Zero) Marshal.Release(unknown);
        }
    }

    // Explorer can own several windows and the topmost one may be minimized while another is
    // on screen. Prefer a window that is already visible and fall back to a minimized one,
    // which the caller restores.
    private static IntPtr FindExplorerWindow()
    {
        List<IntPtr> windows = FindExplorerWindows();
        for (int index = 0; index < windows.Count; index++)
        {
            if (!IsIconic(windows[index])) return windows[index];
        }
        return windows.Count > 0 ? windows[0] : IntPtr.Zero;
    }

    private static List<IntPtr> FindExplorerWindows()
    {
        var windows = new List<IntPtr>();
        EnumWindowsCallback callback = delegate(IntPtr window, IntPtr parameter)
        {
            if (IsWindowVisible(window) && IsWindowOfClass(window, ExplorerWindowClass)) windows.Add(window);
            return true;
        };
        EnumWindows(callback, IntPtr.Zero);
        GC.KeepAlive(callback);
        return windows;
    }

    private static bool IsWindowOfClass(IntPtr window, string expectedClass)
    {
        var className = new StringBuilder(256);
        int written = GetClassName(window, className, className.Capacity);
        return written > 0 && string.Equals(className.ToString(), expectedClass, StringComparison.Ordinal);
    }

    private static bool RestoreExplorerWindow(IntPtr explorerWindow)
    {
        if (!IsIconic(explorerWindow)) return true;

        ShowWindow(explorerWindow, ShowWindowRestore);
        if (!WaitFor(ExplorerRestoreTimeoutMs, delegate { return !IsIconic(explorerWindow); }))
        {
            Log("the window stayed minimized");
            return false;
        }
        // Explorer redraws its tab strip and address bar while the restore animation runs.
        Thread.Sleep(ExplorerRestoreSettleDelayMs);
        Log("window restored");
        return true;
    }

    // A foreground window is not necessarily ready for input: right after a restore, or while a
    // new tab is being created, Explorer briefly owns no focused control and every keystroke is
    // discarded. That is exactly what dropped the path when the window started out minimized.
    private static bool WaitForExplorerInputFocus(IntPtr explorerWindow, string stage)
    {
        bool ready = WaitFor(InputFocusTimeoutMs, delegate
        {
            return GetFocusedControl(explorerWindow) != IntPtr.Zero;
        });
        Log("input focus " + stage + ": " + (ready ? "ready" : "timed out"));
        return ready;
    }

    private static IntPtr GetFocusedControl(IntPtr explorerWindow)
    {
        var info = new GuiThreadInfo();
        info.Size = Marshal.SizeOf(typeof(GuiThreadInfo));
        uint thread = GetWindowThreadProcessId(explorerWindow, IntPtr.Zero);
        if (thread == 0 || !GetGUIThreadInfo(thread, ref info)) return IntPtr.Zero;
        if (info.FocusWindow == IntPtr.Zero) return IntPtr.Zero;
        return GetAncestor(info.FocusWindow, GetAncestorRoot) == explorerWindow ? info.FocusWindow : IntPtr.Zero;
    }

    // Ctrl+L is silently dropped whenever Explorer is still busy, so send it again until the
    // address bar edit really holds the focus rather than assuming a single delay is enough.
    private static IntPtr FocusAddressBar(IntPtr explorerWindow)
    {
        for (int attempt = 1; attempt <= AddressBarAttempts; attempt++)
        {
            if (!SendToExplorer(explorerWindow, "^l")) return IntPtr.Zero;

            IntPtr addressBar = IntPtr.Zero;
            WaitFor(AddressBarFocusTimeoutMs, delegate
            {
                IntPtr focused = GetFocusedControl(explorerWindow);
                if (focused == IntPtr.Zero || !IsWindowOfClass(focused, AddressBarEditClass)) return false;
                addressBar = focused;
                return true;
            });

            if (addressBar != IntPtr.Zero)
            {
                Log("address bar focused on attempt " + attempt);
                return addressBar;
            }
            Log("address bar not focused on attempt " + attempt);
        }
        return IntPtr.Zero;
    }

    // Read the address bar back instead of hoping the paste arrived. If the clipboard route
    // fails, write the path into the control directly before giving up on the tab.
    private static bool FillAddressBar(IntPtr explorerWindow, IntPtr addressBar, string path)
    {
        for (int attempt = 1; attempt <= PasteAttempts; attempt++)
        {
            if (!PasteThroughClipboard(explorerWindow, path)) return false;
            if (WaitForAddressBarText(addressBar, path))
            {
                Log("path pasted on attempt " + attempt);
                return true;
            }
            Log("paste not visible on attempt " + attempt);
        }

        IntPtr result;
        SendMessageTimeout(addressBar, MessageSetText, IntPtr.Zero, path, SendMessageAbortIfHung,
            (uint)MessageTimeoutMs, out result);
        if (WaitForAddressBarText(addressBar, path))
        {
            Log("path written directly into the address bar");
            return true;
        }
        Log("the address bar never received the path");
        return false;
    }

    // Should a future Explorer build stop using a Win32 edit control for its address bar, the
    // control cannot be read back. Paste anyway rather than losing the tab route entirely: this
    // is what the previous version always did, and it works once Explorer is ready for input.
    private static bool FillAddressBarBlind(IntPtr explorerWindow, string path)
    {
        Log("address bar control not identified; pasting without verification");
        if (!SendToExplorer(explorerWindow, "^l")) return false;
        Thread.Sleep(AddressBarReadyDelayMs);
        return PasteThroughClipboard(explorerWindow, path);
    }

    private static bool PasteThroughClipboard(IntPtr explorerWindow, string path)
    {
        string previousClipboard = null;
        bool hadClipboardText = false;
        try
        {
            hadClipboardText = Clipboard.ContainsText();
            if (hadClipboardText) previousClipboard = Clipboard.GetText();
            Clipboard.SetText(path);
            Thread.Sleep(ClipboardReadyDelayMs);
            if (!SendToExplorer(explorerWindow, "^a")) return false;
            if (!SendToExplorer(explorerWindow, "^v")) return false;
            Thread.Sleep(ClipboardReadyDelayMs);
            return true;
        }
        catch (Exception exception)
        {
            Log("clipboard failed: " + exception.Message);
            return false;
        }
        finally
        {
            try
            {
                if (hadClipboardText) Clipboard.SetText(previousClipboard);
                else Clipboard.Clear();
            }
            catch
            {
                // Explorer has already received the path; clipboard restoration is best-effort.
            }
        }
    }

    private static bool WaitForAddressBarText(IntPtr addressBar, string path)
    {
        return WaitFor(PasteVerifyTimeoutMs, delegate
        {
            // Explorer appends an autocomplete suggestion, so the text only has to start with
            // the requested path.
            return ReadWindowText(addressBar).StartsWith(path, StringComparison.OrdinalIgnoreCase);
        });
    }

    // GetWindowText cannot read a control owned by another process, but WM_GETTEXT is marshalled
    // across processes for standard edit controls.
    private static string ReadWindowText(IntPtr window)
    {
        var text = new StringBuilder(1024);
        IntPtr result;
        IntPtr sent = SendMessageTimeout(window, MessageGetText, new IntPtr(text.Capacity), text,
            SendMessageAbortIfHung, (uint)MessageTimeoutMs, out result);
        return sent == IntPtr.Zero ? string.Empty : text.ToString();
    }

    // Leaving the tab that was opened for a path we could not reach would be worse than not
    // having opened it, because the caller falls back to a separate window.
    private static void CloseUnusedTab(IntPtr explorerWindow)
    {
        if (GetForegroundWindow() != explorerWindow) return;
        SendKeys.SendWait("^w");
        Log("closed the unused tab");
    }

    // Keystrokes go to whichever window owns the focus, so never send one unless the intended
    // Explorer window is confirmed to be in the foreground.
    private static bool SendToExplorer(IntPtr explorerWindow, string keys)
    {
        if (!ActivateExplorerWindow(explorerWindow))
        {
            Log("lost the foreground before sending " + keys);
            return false;
        }
        SendKeys.SendWait(keys);
        return true;
    }

    private static bool ActivateExplorerWindow(IntPtr explorerWindow)
    {
        return WaitFor(ExplorerFocusTimeoutMs, delegate
        {
            if (GetForegroundWindow() == explorerWindow) return true;
            if (IsIconic(explorerWindow)) ShowWindow(explorerWindow, ShowWindowRestore);
            ForceForeground(explorerWindow);
            return GetForegroundWindow() == explorerWindow;
        });
    }

    // Windows refuses SetForegroundWindow for a background process such as this host, which is
    // why a restored window could stay behind Chrome. Attaching to the foreground thread's input
    // queue lifts that restriction for the duration of the call.
    private static void ForceForeground(IntPtr window)
    {
        uint currentThread = GetCurrentThreadId();
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        bool attached = foregroundThread != 0 && foregroundThread != currentThread
            && AttachThreadInput(currentThread, foregroundThread, true);
        try
        {
            BringWindowToTop(window);
            SetForegroundWindow(window);
        }
        finally
        {
            if (attached) AttachThreadInput(currentThread, foregroundThread, false);
        }
    }

    private static bool WaitFor(int timeoutMs, Func<bool> condition)
    {
        int waited = 0;
        while (true)
        {
            if (condition()) return true;
            if (waited >= timeoutMs) return false;
            Thread.Sleep(PollRetryMs);
            waited += PollRetryMs;
        }
    }

    private static void OpenInNewExplorerWindow(string path)
    {
        List<IntPtr> before = FindExplorerWindows();
        Process.Start(new ProcessStartInfo("explorer.exe", "/n," + Quote(path)) { UseShellExecute = false });

        // Explorer reuses its running process to create the window, so the new window can appear
        // behind Chrome. Wait for it and bring it forward.
        IntPtr opened = IntPtr.Zero;
        WaitFor(NewWindowTimeoutMs, delegate
        {
            List<IntPtr> current = FindExplorerWindows();
            for (int index = 0; index < current.Count; index++)
            {
                if (!before.Contains(current[index]))
                {
                    opened = current[index];
                    return true;
                }
            }
            return false;
        });
        if (opened != IntPtr.Zero) ActivateExplorerWindow(opened);
    }

    private static int GetWindowsBuildNumber()
    {
        try
        {
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
            {
                int build;
                return int.TryParse(Convert.ToString(key.GetValue("CurrentBuildNumber")), out build) ? build : 0;
            }
        }
        catch
        {
            return 0;
        }
    }

    private static byte[] ReadExactly(Stream stream, int count)
    {
        byte[] buffer = new byte[count];
        int offset = 0;
        while (offset < count)
        {
            int read = stream.Read(buffer, offset, count - offset);
            if (read == 0) throw new EndOfStreamException();
            offset += read;
        }
        return buffer;
    }

    // A trailing backslash would escape the closing quote and hand Explorer a broken path, so a
    // path such as "D:\" has to have its trailing run doubled. Quotes cannot occur in a Windows
    // path and are dropped rather than escaped.
    private static string Quote(string value)
    {
        string sanitized = value.Replace("\"", string.Empty);
        int trailingBackslashes = 0;
        while (trailingBackslashes < sanitized.Length
            && sanitized[sanitized.Length - 1 - trailingBackslashes] == '\\')
        {
            trailingBackslashes++;
        }
        return "\"" + sanitized + new string('\\', trailingBackslashes) + "\"";
    }

    private static void Log(string message)
    {
        Diagnostics.AppendLine(DateTime.Now.ToString("HH:mm:ss.fff") + "  " + message);
    }

    // The tab route depends on timing inside Explorer, so record what happened during the last
    // click. This file is the fastest way to tell which step failed on a given machine.
    private static void WriteDiagnostics()
    {
        try
        {
            string directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FolderPathMemo");
            Directory.CreateDirectory(directory);
            File.WriteAllText(Path.Combine(directory, "last-open.log"), Diagnostics.ToString(), Encoding.UTF8);
        }
        catch
        {
            // Diagnostics must never break opening a folder.
        }
    }

    private static void Write(Stream output, string json)
    {
        byte[] payload = Encoding.UTF8.GetBytes(json);
        byte[] length = BitConverter.GetBytes(payload.Length);
        output.Write(length, 0, length.Length);
        output.Write(payload, 0, payload.Length);
        output.Flush();
    }
}
