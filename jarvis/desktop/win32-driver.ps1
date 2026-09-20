# ---------------------------------------------------------------------------
#  Драйвер рабочего стола: мышь, клавиатура, снимки экрана, окна.
#
#  Живёт одним процессом и читает команды построчно из stdin, отвечая строкой
#  JSON в stdout. Запуск PowerShell и компиляция Add-Type стоят несколько сотен
#  миллисекунд — приемлемо один раз и неприемлемо на каждый клик.
#
#  Ввод делается через SendInput, а не SendKeys: SendKeys требует особого
#  экранирования и плохо работает с кириллицей, а SendInput с флагом UNICODE
#  печатает любой символ независимо от раскладки.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class Desk {
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public MOUSEINPUT mi;
        [FieldOffset(8)] public KEYBDINPUT ki;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    // CharSet.Unicode обязателен: без него зовётся однобайтовая версия, и
    // заголовки на кириллице и иврите приходят как «??????» — по ним нельзя
    // ни найти окно, ни показать его человеку.
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);

    public delegate bool EnumProc(IntPtr h, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
}
"@

[void][Desk]::SetProcessDPIAware()

# Структура собирается целиком и лишь потом кладётся в INPUT.
#
# PowerShell возвращает значимые типы копией: `$input.mi.dwFlags = ...` меняет
# временную копию, а в самой структуре остаются нули. SendInput при этом
# отвечает «принято» и не делает ничего — курсор двигался только потому, что
# это отдельный вызов SetCursorPos, а клики молча пропадали.
function Send-Mouse([uint32] $flags, [int] $data) {
    $mouse = New-Object Desk+MOUSEINPUT
    $mouse.dwFlags = $flags
    $mouse.mouseData = [uint32] $data

    $event = New-Object Desk+INPUT
    $event.type = 0
    $event.mi = $mouse

    $sent = [Desk]::SendInput(1, @($event), [Runtime.InteropServices.Marshal]::SizeOf([type]([Desk+INPUT])))
    if ($sent -ne 1) { throw "Windows отклонил событие мыши (код $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
}

function Send-Char([char] $ch, [bool] $up) {
    $flags = [Desk]::KEYEVENTF_UNICODE
    if ($up) { $flags = $flags -bor [Desk]::KEYEVENTF_KEYUP }

    $key = New-Object Desk+KEYBDINPUT
    $key.wVk = 0
    $key.wScan = [uint16] $ch
    $key.dwFlags = $flags

    $event = New-Object Desk+INPUT
    $event.type = 1
    $event.ki = $key

    $sent = [Desk]::SendInput(1, @($event), [Runtime.InteropServices.Marshal]::SizeOf([type]([Desk+INPUT])))
    if ($sent -ne 1) { throw "Windows отклонил символ (код $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
}

function Send-VirtualKey([uint16] $vk, [bool] $up) {
    $key = New-Object Desk+KEYBDINPUT
    $key.wVk = $vk
    $key.dwFlags = if ($up) { [Desk]::KEYEVENTF_KEYUP } else { 0 }

    $event = New-Object Desk+INPUT
    $event.type = 1
    $event.ki = $key

    $sent = [Desk]::SendInput(1, @($event), [Runtime.InteropServices.Marshal]::SizeOf([type]([Desk+INPUT])))
    if ($sent -ne 1) { throw "Windows отклонил клавишу (код $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
}

# Имена клавиш, как их называет человек, в виртуальные коды Windows.
$VK = @{
    'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'shift' = 0x10; 'win' = 0x5B;
    'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B;
    'space' = 0x20; 'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E;
    'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22;
    'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27;
    'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75;
    'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B;
}

function Resolve-Key([string] $name) {
    $key = $name.ToLower().Trim()
    if ($VK.ContainsKey($key)) { return [uint16] $VK[$key] }
    if ($key.Length -eq 1) {
        $ch = $key.ToUpper()[0]
        if (($ch -ge 'A' -and $ch -le 'Z') -or ($ch -ge '0' -and $ch -le '9')) { return [uint16] $ch }
    }
    throw "Неизвестная клавиша: $name"
}

function Get-Windows {
    $result = New-Object System.Collections.ArrayList
    $callback = [Desk+EnumProc] {
        param($handle, $lParam)
        if ([Desk]::IsWindowVisible($handle)) {
            $sb = New-Object System.Text.StringBuilder 512
            [void][Desk]::GetWindowTextW($handle, $sb, 512)
            $title = $sb.ToString()
            if ($title.Length -gt 0) {
                $rect = New-Object Desk+RECT
                [void][Desk]::GetWindowRect($handle, [ref] $rect)
                $width = $rect.Right - $rect.Left
                $height = $rect.Bottom - $rect.Top
                # Окна нулевого размера и служебные полоски человеку не нужны.
                if ($width -gt 80 -and $height -gt 40) {
                    $processId = 0
                    [void][Desk]::GetWindowThreadProcessId($handle, [ref] $processId)
                    [void]$result.Add([PSCustomObject]@{
                        title = $title
                        x = $rect.Left; y = $rect.Top; width = $width; height = $height
                        pid = $processId
                        focused = ($handle -eq [Desk]::GetForegroundWindow())
                    })
                }
            }
        }
        return $true
    }
    [void][Desk]::EnumWindows($callback, [IntPtr]::Zero)
    return $result
}

function Save-Screenshot([string] $path, $region) {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $x = $bounds.X; $y = $bounds.Y; $w = $bounds.Width; $h = $bounds.Height
    if ($region) { $x = [int]$region.x; $y = [int]$region.y; $w = [int]$region.width; $h = [int]$region.height }

    $bitmap = New-Object System.Drawing.Bitmap $w, $h
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $graphics.Dispose()
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    return @{ path = $path; x = $x; y = $y; width = $w; height = $h }
}

<#
    Elementy okna cherez UI Automation.

    Eto ta zhe sistema, kotoroy polzuyutsya ekrannye chitalki: ona znaet
    nazvaniya knopok i ih koordinaty, poetomu klik po nazvaniyu ne trebuet ni
    snimka ekrana, ni ugadyvaniya pikseley.

    Vazhnoe nablyudenie s etoy mashiny: interfeys Windows na ivrite, i pole
    Name prihodit na ivrite, a AutomationId ostayotsya angliyskim i stabilnym
    (CloseButton, AddButton). Poetomu vozvrashchayutsya oba polya - sopostavlyat
    nado po oboim.
#>
function Get-Elements {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop

    $hwnd = [Desk]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { return @() }

    $window = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $window) { return @() }

    $found = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)

    $items = @()
    foreach ($element in $found) {
        $current = $element.Current
        if ($current.IsOffscreen) { continue }

        $name = $current.Name
        $id = $current.AutomationId
        if (-not $name -and -not $id) { continue }

        $rect = $current.BoundingRectangle
        if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }

        $items += @{
            name = $name
            id = $id
            type = ($current.ControlType.ProgrammaticName -replace 'ControlType\.', '')
            enabled = $current.IsEnabled
            x = [int]($rect.X + $rect.Width / 2)
            y = [int]($rect.Y + $rect.Height / 2)
            width = [int]$rect.Width
            height = [int]$rect.Height
        }
    }
    return $items
}

function Invoke-Command2($message) {
    switch ($message.cmd) {
        'elements' {
            $sb = New-Object System.Text.StringBuilder 512
            [void][Desk]::GetWindowTextW([Desk]::GetForegroundWindow(), $sb, 512)
            return @{ title = $sb.ToString(); elements = Get-Elements }
        }
        'screen' {
            $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
            return @{ width = $b.Width; height = $b.Height; x = $b.X; y = $b.Y }
        }
        'screenshot' { return Save-Screenshot $message.path $message.region }
        'windows'    { return @{ windows = Get-Windows } }
        'cursor'     { $p = New-Object Desk+POINT; [void][Desk]::GetCursorPos([ref] $p); return @{ x = $p.X; y = $p.Y } }
        'move'       { [void][Desk]::SetCursorPos([int]$message.x, [int]$message.y); return @{ ok = $true } }
        'click' {
            if ($null -ne $message.x) { [void][Desk]::SetCursorPos([int]$message.x, [int]$message.y); Start-Sleep -Milliseconds 30 }
            $button = if ($message.button) { $message.button } else { 'left' }
            $down = switch ($button) { 'right' { [Desk]::MOUSEEVENTF_RIGHTDOWN } 'middle' { [Desk]::MOUSEEVENTF_MIDDLEDOWN } default { [Desk]::MOUSEEVENTF_LEFTDOWN } }
            $up   = switch ($button) { 'right' { [Desk]::MOUSEEVENTF_RIGHTUP }   'middle' { [Desk]::MOUSEEVENTF_MIDDLEUP }   default { [Desk]::MOUSEEVENTF_LEFTUP } }
            $times = if ($message.double) { 2 } else { 1 }
            for ($i = 0; $i -lt $times; $i++) {
                Send-Mouse $down 0
                Send-Mouse $up 0
                if ($times -gt 1) { Start-Sleep -Milliseconds 60 }
            }
            return @{ ok = $true }
        }
        'scroll' {
            if ($null -ne $message.x) { [void][Desk]::SetCursorPos([int]$message.x, [int]$message.y); Start-Sleep -Milliseconds 30 }
            # Колесо считает «щелчками» по 120 единиц; вниз — отрицательные.
            Send-Mouse ([Desk]::MOUSEEVENTF_WHEEL) ([int]$message.amount * 120)
            return @{ ok = $true }
        }
        'type' {
            foreach ($ch in [char[]] $message.text) {
                Send-Char $ch $false
                Send-Char $ch $true
                Start-Sleep -Milliseconds 5
            }
            return @{ ok = $true }
        }
        'key' {
            $parts = @($message.keys -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
            $codes = @($parts | ForEach-Object { Resolve-Key $_ })
            foreach ($code in $codes) { Send-VirtualKey $code $false }
            [array]::Reverse($codes)
            foreach ($code in $codes) { Send-VirtualKey $code $true }
            return @{ ok = $true }
        }
        'focus' {
            # Snachala po zagolovku, potom po imeni processa.
            #
            # «Pereklyuchis na edzh» prihodit syuda kak "msedge" — eto imya
            # ispolnyaemogo fayla, a v zagolovke okna napisano "Microsoft Edge".
            # U Chrome sovpadalo sluchayno, u Edge net, i chelovek slyshal
            # «ne poluchilos» na komandu, kotoraya obyazana rabotat vsegda.
            $needle = $message.title
            $windows = Get-Windows
            $target = $windows | Where-Object { $_.title -like "*$needle*" } | Select-Object -First 1
            if (-not $target) {
                $target = $windows | Where-Object {
                    $proc = Get-Process -Id $_.pid -ErrorAction SilentlyContinue
                    $proc -and ($proc.ProcessName -like "*$needle*")
                } | Select-Object -First 1
            }
            if (-not $target) { throw "Окно не найдено: $needle" }
            $handle = [IntPtr]::Zero
            $callback = [Desk+EnumProc] {
                param($h, $l)
                $sb = New-Object System.Text.StringBuilder 512
                [void][Desk]::GetWindowTextW($h, $sb, 512)
                if ($sb.ToString() -eq $target.title) { $script:handle = $h; return $false }
                return $true
            }
            [void][Desk]::EnumWindows($callback, [IntPtr]::Zero)
            if ($handle -ne [IntPtr]::Zero) {
                [void][Desk]::ShowWindow($handle, 9)
                [void][Desk]::SetForegroundWindow($handle)
            }
            return @{ ok = $true; title = $target.title }
        }
        default { throw "Неизвестная команда: $($message.cmd)" }
    }
}

<#
    Chtenie stdin v UTF-8.

    Bez etogo PowerShell dekodiruet vhod kodovoy stranicey konsoli, i vsyo
    nelatinskoe prihodit musorom: "Proverka" prevrashchaetsya v nabor
    psevdografiki. Posledstviya byli tihimi i dorogimi - diktovka po-russki
    pechatala by bessmyslicu, a pereklyuchenie na okno s russkim ili ivritskim
    zagolovkom ne nahodilo ego nikogda.

    Chitaem potokom s yavnoy kodirovkoy, a ne cherez [Console]::In: pri
    perenapravlennom vhode ustanovka InputEncoding rabotaet ne vsegda.
#>
$stdin = New-Object System.IO.StreamReader(
    [Console]::OpenStandardInput(),
    (New-Object System.Text.UTF8Encoding $false))

Write-Output (ConvertTo-Json @{ type = 'ready' } -Compress)

while ($true) {
    $line = $stdin.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }

    $id = $null
    try {
        $message = $line | ConvertFrom-Json
        $id = $message.id
        $result = Invoke-Command2 $message
        Write-Output (ConvertTo-Json @{ id = $id; result = $result } -Compress -Depth 6)
    } catch {
        Write-Output (ConvertTo-Json @{ id = $id; error = $_.Exception.Message } -Compress)
    }
}
