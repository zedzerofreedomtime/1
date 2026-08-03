using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Globalization;

/// <summary>
/// เคลื่อนเคอร์เซอร์เมาส์จริงบนหน้าจอตาม Bezier path
/// Compatible with .NET Framework 4.x (no System.Text.Json needed)
/// </summary>
class MoveCursor
{
    [DllImport("user32.dll")]
    static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);

    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;

    static double ParseNum(string json, string key)
    {
        string search = "\"" + key + "\":";
        int idx = json.IndexOf(search);
        if (idx < 0) return 0;
        idx += search.Length;
        // skip whitespace
        while (idx < json.Length && (json[idx] == ' ' || json[idx] == '\t')) idx++;
        int end = idx;
        while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '.' || json[end] == '-' || json[end] == 'e' || json[end] == 'E' || json[end] == '+'))
            end++;
        string val = json.Substring(idx, end - idx);
        return double.Parse(val, CultureInfo.InvariantCulture);
    }

    static bool ParseBool(string json, string key)
    {
        string search = "\"" + key + "\":";
        int idx = json.IndexOf(search);
        if (idx < 0) return false;
        idx += search.Length;
        while (idx < json.Length && json[idx] == ' ') idx++;
        return json.Substring(idx, Math.Min(4, json.Length - idx)).StartsWith("true");
    }

    static List<string> SplitObjects(string arrayContent)
    {
        var results = new List<string>();
        int depth = 0;
        int start = -1;
        for (int i = 0; i < arrayContent.Length; i++)
        {
            if (arrayContent[i] == '{') { if (depth == 0) start = i; depth++; }
            else if (arrayContent[i] == '}') { depth--; if (depth == 0 && start >= 0) { results.Add(arrayContent.Substring(start, i - start + 1)); start = -1; } }
        }
        return results;
    }

    static void Main(string[] args)
    {
        if (args.Length < 1) { Console.Error.WriteLine("Usage: move-cursor.exe <json-file>"); Environment.Exit(1); }

        string jsonFile = args[0];
        if (!File.Exists(jsonFile)) { Console.Error.WriteLine("File not found: " + jsonFile); Environment.Exit(1); }

        try
        {
            string json = File.ReadAllText(jsonFile);
            bool doClick = ParseBool(json, "click");

            // Extract path array content
            int pathStart = json.IndexOf("\"path\"");
            if (pathStart < 0) { Console.Error.WriteLine("No path array found"); Environment.Exit(1); }
            int arrStart = json.IndexOf('[', pathStart);
            int arrEnd = json.IndexOf(']', arrStart);
            string arrContent = json.Substring(arrStart, arrEnd - arrStart + 1);

            var points = SplitObjects(arrContent);
            foreach (string point in points)
            {
                int x = (int)Math.Round(ParseNum(point, "x"));
                int y = (int)Math.Round(ParseNum(point, "y"));
                double delay = ParseNum(point, "delay");

                SetCursorPos(x, y);
                if (delay > 0)
                    Thread.Sleep((int)Math.Round(delay));
            }

            if (doClick)
            {
                var rng = new Random();
                Thread.Sleep(30 + rng.Next(50));
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                Thread.Sleep(40 + rng.Next(40));
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
            }

            try { File.Delete(jsonFile); } catch { }
            Console.Write("{\"ok\":true}");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            Environment.Exit(1);
        }
    }
}
