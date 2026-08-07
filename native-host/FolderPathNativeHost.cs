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
    private const int NewTabReadyDelayMs = 1500;
    private const int AddressBarReadyDelayMs = 500;
    private const int ClipboardReadyDelayMs = 150;
    private const int NavigationStartDelayMs = 1200;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

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

        IntPtr explorerWindow = FindWindow("CabinetWClass", null);
        if (explorerWindow == IntPtr.Zero) return false;

        // Keystrokes sent while a minimized Explorer is being restored can create a Home tab
        // without reaching its address bar. Use Explorer's command line instead; /n guarantees
        // a separate window and lets Explorer itself navigate to the requested path.
        if (IsIconic(explorerWindow)) return false;

        if (!ActivateExplorerWindow(explorerWindow)) return false;
        Thread.Sleep(ExplorerActivationDelayMs);
        SendKeys.SendWait("^t");
        Thread.Sleep(NewTabReadyDelayMs);
        if (!ActivateExplorerWindow(explorerWindow)) return false;
        SendKeys.SendWait("^l");
        Thread.Sleep(AddressBarReadyDelayMs);

        string previousClipboard = null;
        bool hadClipboardText = false;
        try
        {
            hadClipboardText = Clipboard.ContainsText();
            if (hadClipboardText) previousClipboard = Clipboard.GetText();
            Clipboard.SetText(path);
            Thread.Sleep(ClipboardReadyDelayMs);
            SendKeys.SendWait("^v");
            Thread.Sleep(ClipboardReadyDelayMs);
            SendKeys.SendWait("{ENTER}");
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

    private static bool ActivateExplorerWindow(IntPtr explorerWindow)
    {
        int waited = 0;
        while (waited <= ExplorerFocusTimeoutMs)
        {
            SetForegroundWindow(explorerWindow);
            if (GetForegroundWindow() == explorerWindow) return true;
            Thread.Sleep(ExplorerFocusRetryMs);
            waited += ExplorerFocusRetryMs;
        }
        return false;
    }

    private static void OpenInNewExplorerWindow(string path)
    {
        Process.Start(new ProcessStartInfo("explorer.exe", "/n," + Quote(path)) { UseShellExecute = false });
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

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
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
