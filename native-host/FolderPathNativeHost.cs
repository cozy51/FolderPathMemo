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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

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
                    Process.Start(new ProcessStartInfo("explorer.exe", Quote(path)) { UseShellExecute = false });
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

        ShowWindow(explorerWindow, 9);
        if (!SetForegroundWindow(explorerWindow)) return false;
        Thread.Sleep(150);
        SendKeys.SendWait("^t");
        Thread.Sleep(250);
        SendKeys.SendWait("^l");
        Thread.Sleep(100);
        SendKeys.SendWait(EscapeForSendKeys(path) + "{ENTER}");
        return true;
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

    private static string EscapeForSendKeys(string value)
    {
        var escaped = new StringBuilder(value.Length * 2);
        foreach (char character in value)
        {
            if ("+^%~()[]{}".IndexOf(character) >= 0)
            {
                escaped.Append('{').Append(character).Append('}');
            }
            else
            {
                escaped.Append(character);
            }
        }
        return escaped.ToString();
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
