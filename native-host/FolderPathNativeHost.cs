using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Web.Script.Serialization;

internal static class FolderPathNativeHost
{
    private const int MaximumMessageBytes = 1024 * 1024;

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

                Process.Start(new ProcessStartInfo("explorer.exe", Quote(path)) { UseShellExecute = false });
                Write(output, "{\"ok\":true}");
            }
            catch (Exception exception)
            {
                var serializer = new JavaScriptSerializer();
                Write(output, serializer.Serialize(new { ok = false, error = exception.Message }));
            }
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
