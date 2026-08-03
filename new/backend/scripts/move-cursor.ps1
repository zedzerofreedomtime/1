<#
.SYNOPSIS
  เคลื่อนเคอร์เซอร์เมาส์จริงบนหน้าจอตาม Bezier path

.DESCRIPTION
  รับ path ไปยังไฟล์ JSON ที่มี path array ผ่าน argument
  แล้วเคลื่อนเคอร์เซอร์ + คลิก (ถ้ามี flag click=true)
  ใช้ Windows API SetCursorPos จาก user32.dll

.NOTES
  เรียกจาก ClipBot server.ts เท่านั้น
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$JsonFile
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class CursorMover {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(
        uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);

    public const uint MOUSEEVENTF_LEFTDOWN  = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP    = 0x0004;

    public static void Click() {
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        Thread.Sleep(40 + new Random().Next(40));
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    }
}
"@

if (-not (Test-Path $JsonFile)) {
    Write-Error "JSON file not found: $JsonFile"
    exit 1
}

try {
    $data = Get-Content -Path $JsonFile -Raw | ConvertFrom-Json
    $doClick = $false
    if ($data.click -eq $true) { $doClick = $true }

    foreach ($point in $data.path) {
        $px = [int]([Math]::Round([double]$point.x))
        $py = [int]([Math]::Round([double]$point.y))
        [CursorMover]::SetCursorPos($px, $py)
        if ([double]$point.delay -gt 0) {
            Start-Sleep -Milliseconds ([int]([Math]::Round([double]$point.delay)))
        }
    }

    if ($doClick) {
        Start-Sleep -Milliseconds (30 + (Get-Random -Maximum 50))
        [CursorMover]::Click()
    }

    # ลบไฟล์ temp หลังเสร็จ
    Remove-Item -Path $JsonFile -ErrorAction SilentlyContinue

    Write-Output '{"ok":true}'
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
