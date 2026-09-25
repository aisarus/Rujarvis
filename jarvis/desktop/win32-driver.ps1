# ---------------------------------------------------------------------------
#  Драйвер рабочего стола: мышь, клавиатура, снимки экрана, окна.
#
#  ФАЙЛ СОХРАНЁН С BOM, и это не вкусовщина. Драйвер запускается командой
#  `powershell`, то есть Windows PowerShell 5.1, а он читает файл без BOM в
#  кодовой странице ANSI: кириллица в сообщениях об ошибках доезжала до
#  агента набором случайных знаков, и понять, что именно не так, было нельзя.
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
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    // CharSet.Unicode обязателен: без него зовётся однобайтовая версия, и
    // заголовки на кириллице и иврите приходят как «??????» — по ним нельзя
    // ни найти окно, ни показать его человеку.
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint to, bool join);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, IntPtr extra);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint winIni);

    /*
        Podnyat okno po-nastoyashchemu.

        SetForegroundWindow odin molcha ne srabatyvaet, kogda speredi chuzhoe
        polnoekrannoe okno: Windows zapreshchaet kradezh fokusa processu, kotoryy
        im ne vladeet. Vyzov vozvrashchaet false, a drayver ranshe otchityvalsya
        uspehom - i chelovek slyshal "pereklyuchilsya", glyadya na to zhe okno.

        Tri veshchi vmeste snimayut zapret: kasanie ALT snimaet blokirovku vvoda,
        AttachThreadInput na vremya delaet nas sosedom aktivnogo potoka, i tolko
        posle etogo ShowWindow + BringWindowToTop + SetForegroundWindow rabotayut.

        Vozvrashchaem zagolovok togo okna, kotoroe DEYSTVITELNO vperedi posle
        popytki. Otchitatsya mozhno tolko tem, chto proveril.
    */
    public static string Raise(IntPtr h) {
        /*
            Snyat blokirovku fokusa, no BEZ nazhatiya klavish.
            
            Ranshe zdes bylo kasanie ALT - obshcheizvestnyy priyom. Na etoy
            mashine ono otkryvalo "Pereklyuchenie zadach": proverka deystviy
            pokazala, chto posle "pereklyuchis na edzh" vperedi okazyvalsya
            Alt-Tab, a ne Edge. Lechenie okazalos huzhe bolezni.
            
            SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001. Stavim nol na vremya
            perekhoda i vozvrashchaem kak bylo: nikakogo vvoda, nikakih okon.
        */
        const uint GET_LOCK = 0x2000, SET_LOCK = 0x2001, SEND_CHANGE = 0x02;
        IntPtr was = Marshal.AllocHGlobal(4);
        SystemParametersInfo(GET_LOCK, 0, was, 0);
        SystemParametersInfo(SET_LOCK, 0, IntPtr.Zero, SEND_CHANGE);

        uint dummy;
        uint front = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
        uint mine = GetCurrentThreadId();
        uint target = GetWindowThreadProcessId(h, out dummy);

        AttachThreadInput(mine, front, true);
        AttachThreadInput(mine, target, true);
        ShowWindow(h, 9);
        BringWindowToTop(h);
        SetForegroundWindow(h);
        AttachThreadInput(mine, target, false);
        AttachThreadInput(mine, front, false);

        /*
            Vozvrashchaem ZNACHENIE, a ne adres.
            
            U SPI_GETFOREGROUNDLOCKTIMEOUT pvParam - eto ukazatel na DWORD, a u
            SPI_SETFOREGROUNDLOCKTIMEOUT - samo znachenie, privedyonnoe k PVOID.
            Zdes peredavalsya `was`, to est adres bufera: Windows poluchal
            timeout v milliony millisekund, i posle pervogo zhe pereklyucheniya
            sistema pochti perestavala otdavat fokus komu-libo v etom seanse.
            Kommentariy obeshchal "vozvrashchaem kak bylo" - kod etogo ne delal.
        */
        uint bylo = (uint)Marshal.ReadInt32(was);
        Marshal.FreeHGlobal(was);
        SystemParametersInfo(SET_LOCK, 0, new IntPtr((int)bylo), SEND_CHANGE);

        System.Threading.Thread.Sleep(250);
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(GetForegroundWindow(), sb, 512);
        return sb.ToString();
    }

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
    # Kolesо vniz - eto otricatelnoe chislo, a pole struktury bez znaka.
    # Pryamoe privedenie [uint32] -600 brosaet, i prokrutka vniz ne rabotala
    # voobshche: agent poluchal "Ne udaetsya preobrazovat -600 v UInt32".
    # Perevodim v dopolnitelnyy kod, kak eto i ponimaet Windows.
    # Bukva L obyazatelna: bez nee PowerShell chitaet 0xFFFFFFFF kak znakovoe
    # -1, maska nichego ne daet, i privedenie snova brosaet.
    $mouse.mouseData = [uint32]([int64]$data -band 0xFFFFFFFFL)

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

<#
    Sravnenie bez «yo».

    Razbor frazy privodit rech k odnomu vidu i menyaet «yo» na «e»: chelovek
    govorit odinakovo, a pishet po-raznomu. No v ZAGOLOVKE okna «yo» ostayotsya
    kak est, i poisk po dословnomu sovpadeniyu promahivaetsya.

    Poymano priyomkoy 25.09.2026: okno «Proba priyomki Rujarvis» ne nashlos po
    fraze, kotoraya prishla syuda kak «proba priemki rujarvis». Lyuboe russkoe
    okno s «yo» v imeni tak zhe ne nashlos by.
#>
function Simplify-Text {
    param([string] $Text)
    if ($null -eq $Text) { return '' }
    return $Text.ToLower().Replace([char]0x0451, [char]0x0435).Replace([char]0x0401, [char]0x0435)
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

                # Svyornutoe okno tozhe okno.
                #
                # Windows otdayot svyornutoe okno ogryzkom: 159x27 v tochke
                # (-25600,-25600). Proverka razmera vybrasyvala ego - i
                # «pereklyuchis na edzh» ne nahodilo Edge imenno togda, kogda
                # eto nuzhnee vsego: kogda okno svyornuto. Zamereno na mashine
                # cheloveka 24.09.2026, dvazhdy podryad, s otvetom «ne
                # poluchilos».
                #
                # Poetomu razmer sprashivaem tolko u nesvyornutyh: tam on i
                # vpravdu otdelyaet okno ot sluzhebnoy poloski.
                $minimized = [Desk]::IsIconic($handle)
                if ($minimized -or ($width -gt 80 -and $height -gt 40)) {
                    $processId = 0
                    [void][Desk]::GetWindowThreadProcessId($handle, [ref] $processId)
                    [void]$result.Add([PSCustomObject]@{
                        title = $title
                        handle = [int64]$handle
                        x = $rect.Left; y = $rect.Top; width = $width; height = $height
                        pid = $processId
                        minimized = [bool]$minimized
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
            $simple = Simplify-Text $needle
            $windows = Get-Windows
            $target = $windows | Where-Object { (Simplify-Text $_.title).Contains($simple) } | Select-Object -First 1
            if (-not $target) {
                # "Program Manager" - eto rabochiy stol, a ne okno Provodnika.
                # On vo ves ekran, poetomu sortirovka po ploshchadi stavila ego
                # pervym: «pereklyuchis na provodnik» pokazyvalo pustoy stol.
                $target = $windows | Where-Object {
                    $_.title -ne 'Program Manager' -and
                    ($proc = Get-Process -Id $_.pid -ErrorAction SilentlyContinue) -and
                    (Simplify-Text $proc.ProcessName).Contains($simple)
                } | Sort-Object { $_.width * $_.height } -Descending | Select-Object -First 1
            }
            if (-not $target) {
                # Govorim, chto est, a ne prosto «net».
                #
                # «Ne poluchilos» ne govorit cheloveku nichego: ni chto
                # iskali, ni chto ryadom. Spisok togo, chto na ekrane, delaet
                # sleduyushchuyu popytku osmyslennoy.
                $nearby = ($windows | Where-Object { $_.title -ne 'Program Manager' } |
                    ForEach-Object {
                        $proc = (Get-Process -Id $_.pid -ErrorAction SilentlyContinue).ProcessName
                        if ($proc) { $proc } else { $_.title }
                    } | Select-Object -Unique -First 8) -join ', '
                throw "Okno ne naydeno: $needle. Na ekrane: $nearby"
            }
            $handle = [IntPtr][int64]$target.handle
            if ($handle -eq [IntPtr]::Zero) { throw "U okna net deskriptora: $($target.title)" }

            # Otchityvaemsya tem, chto vperedi na samom dele, a ne tem, chto
            # prosili. Ranshe drayver govoril "pereklyuchilsya" dazhe togda,
            # kogda okno ne dvinulos, i agent tratil minutu na vyyasnenie.
            #
            # Sravnivaem deskriptory, a ne zagolovki. Zagolovok - ne imya okna,
            # a nadpis: dva okna Provodnika nazyvayutsya odinakovo, i proverka
            # po nadpisi otchitalas by uspehom, podnyav ne to okno. Deskriptor
            # u kazhdogo okna svoy.
            $nowFront = [Desk]::Raise($handle)
            $frontHandle = [Desk]::GetForegroundWindow()
            if ($frontHandle -ne $handle) {
                throw "Ne vyshlo podnyat okno. Prosili: $($target.title). Vperedi: $nowFront"
            }
            return @{ ok = $true; title = $nowFront }
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
