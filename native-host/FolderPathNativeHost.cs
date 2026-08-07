using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Win32;

internal static class FolderPathNativeHost
{
    private const int MaximumMessageBytes = 1024 * 1024;
    private const int Windows11ExplorerTabsBuild = 22621;
    private const int ExplorerActivationDelayMs = 400;
    private const int ExplorerFocusTimeoutMs = 3000;
    private const int ExplorerFocusRetryMs = 100;
    private const int ExplorerRestoreTimeoutMs = 3000;
    private const int ExplorerRestoreRetryMs = 100;
    private const int ExplorerRestoreSettleDelayMs = 700;
    private const int NewWindowTimeoutMs = 5000;
    private const int NewWindowRetryMs = 100;
    private const int NewTabReadyDelayMs = 1500;
    private const int AddressBarReadyDelayMs = 500;
    private const int ClipboardReadyDelayMs = 150;
    private const int NavigationStartDelayMs = 1200;

    private const string ExplorerWindowClass = "CabinetWClass";
    private const int ShowWindowRestore = 9;

    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);

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
    private static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attachingThread, uint attachedToThread, bool attach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [STAThread]
    public static void Main()
    {
        using (Stream input = Console.OpenStandardInput())
        using (Stream output = Console.OpenStandardOutput())
        {
            try
            {
                byte[] lengthBytes = ReadExactly(input, 4);
                int length = BitConverter.ToInt32(lengthBytes, 0);
                if (length <= 0 || length > MaximumMessageBytes) throw new InvalidDataException("Invalid message size.");

                string json = Encoding.UTF8.GetString(ReadExactly(input, length));
                var serializer = new JavaScriptSerializer();
                var request = serializer.Deserialize<Dictionary<string, object>>(json);
                string path = request.ContainsKey("path") ? Convert.ToString(request["path"]) : string.Empty;
                if (string.IsNullOrWhiteSpace(path) || path.IndexOf('\0') >= 0) throw new InvalidDataException("Invalid folder path.");

                bool openedInTab = TryOpenInExistingExplorerTab(path);
                if (!openedInTab)
                {
                    OpenInNewExplorerWindow(path);
                }
                Write(output, "{\"ok\":true,\"openedInTab\":" + openedInTab.ToString().ToLowerInvariant() + "}");
            }
            catch (Exception exception)
            {
                var serializer = new JavaScriptSerializer();
                Write(output, serializer.Serialize(new { ok = false, error = exception.Message }));
            }
        }
    }

    private static bool TryOpenInExistingExplorerTab(string path)
    {
        if (GetWindowsBuildNumber() < Windows11ExplorerTabsBuild) return false;

        IntPtr explorerWindow = FindExplorerWindow();
        if (explorerWindow == IntPtr.Zero) return false;

        // A minimized window has no keyboard focus, so Ctrl+T used to land nowhere and the
        // path was opened in a separate window instead. Restore the window first and wait
        // until it is really back on screen before sending any keystroke to it.
        if (!RestoreExplorerWindow(explorerWindow)) return false;

        if (!ActivateExplorerWindow(explorerWindow)) return false;
        Thread.Sleep(ExplorerActivationDelayMs);
        if (!SendToExplorer(explorerWindow, "^t")) return false;
        Thread.Sleep(NewTabReadyDelayMs);
        if (!SendToExplorer(explorerWindow, "^l")) return false;
        Thread.Sleep(AddressBarReadyDelayMs);

        string previousClipboard = null;
        bool hadClipboardText = false;
        try
        {
            hadClipboardText = Clipboard.ContainsText();
            if (hadClipboardText) previousClipboard = Clipboard.GetText();
            Clipboard.SetText(path);
            Thread.Sleep(ClipboardReadyDelayMs);
            if (!SendToExplorer(explorerWindow, "^v")) return false;
            Thread.Sleep(ClipboardReadyDelayMs);
            if (!SendToExplorer(explorerWindow, "{ENTER}")) return false;
            Thread.Sleep(NavigationStartDelayMs);
            return true;
        }
        catch
        {
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
            if (IsWindowVisible(window) && IsExplorerWindow(window)) windows.Add(window);
            return true;
        };
        EnumWindows(callback, IntPtr.Zero);
        GC.KeepAlive(callback);
        return windows;
    }

    private static bool IsExplorerWindow(IntPtr window)
    {
        var className = new StringBuilder(256);
        int written = GetClassName(window, className, className.Capacity);
        return written > 0 && string.Equals(className.ToString(), ExplorerWindowClass, StringComparison.Ordinal);
    }

    private static bool RestoreExplorerWindow(IntPtr explorerWindow)
    {
        if (!IsIconic(explorerWindow)) return true;

        ShowWindow(explorerWindow, ShowWindowRestore);
        int waited = 0;
        while (waited <= ExplorerRestoreTimeoutMs)
        {
            if (!IsIconic(explorerWindow))
            {
                // Explorer redraws its tab strip and address bar while the restore animation
                // runs, so give it a moment before the first keystroke.
                Thread.Sleep(ExplorerRestoreSettleDelayMs);
                return !IsIconic(explorerWindow);
            }
            Thread.Sleep(ExplorerRestoreRetryMs);
            waited += ExplorerRestoreRetryMs;
        }
        return false;
    }

    // Keystrokes go to whichever window owns the focus, so never send one unless the intended
    // Explorer window is confirmed to be in the foreground.
    private static bool SendToExplorer(IntPtr explorerWindow, string keys)
    {
        if (!ActivateExplorerWindow(explorerWindow)) return false;
        SendKeys.SendWait(keys);
        return true;
    }

    private static bool ActivateExplorerWindow(IntPtr explorerWindow)
    {
        int waited = 0;
        while (waited <= ExplorerFocusTimeoutMs)
        {
            if (IsIconic(explorerWindow)) ShowWindow(explorerWindow, ShowWindowRestore);
            ForceForeground(explorerWindow);
            if (GetForegroundWindow() == explorerWindow) return true;
            Thread.Sleep(ExplorerFocusRetryMs);
            waited += ExplorerFocusRetryMs;
        }
        return false;
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

    private static void OpenInNewExplorerWindow(string path)
    {
        List<IntPtr> before = FindExplorerWindows();
        Process.Start(new ProcessStartInfo("explorer.exe", "/n," + Quote(path)) { UseShellExecute = false });

        IntPtr opened = WaitForNewExplorerWindow(before);
        if (opened != IntPtr.Zero) ActivateExplorerWindow(opened);
    }

    // Explorer reuses its running process to create the window, so the new window can appear
    // behind Chrome. Wait for it and bring it forward.
    private static IntPtr WaitForNewExplorerWindow(List<IntPtr> before)
    {
        int waited = 0;
        while (waited <= NewWindowTimeoutMs)
        {
            List<IntPtr> current = FindExplorerWindows();
            for (int index = 0; index < current.Count; index++)
            {
                if (!before.Contains(current[index])) return current[index];
            }
            Thread.Sleep(NewWindowRetryMs);
            waited += NewWindowRetryMs;
        }
        return IntPtr.Zero;
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

    private static void Write(Stream output, string json)
    {
        byte[] payload = Encoding.UTF8.GetBytes(json);
        byte[] length = BitConverter.GetBytes(payload.Length);
        output.Write(length, 0, length.Length);
        output.Write(payload, 0, payload.Length);
        output.Flush();
    }
}
