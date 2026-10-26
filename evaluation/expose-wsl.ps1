param(
    [Parameter(Mandatory = $true)][string]$ListenAddress,
    [Parameter(Mandatory = $true)][string]$ConnectAddress,
    [ValidateRange(1, 65535)][int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script in Windows PowerShell as Administrator."
}
foreach ($address in @($ListenAddress, $ConnectAddress)) {
    $parsed = [System.Net.IPAddress]::Parse($address)
    if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        throw "Both addresses must be IPv4 addresses."
    }
}
if (-not (Get-NetIPAddress -IPAddress $ListenAddress -ErrorAction SilentlyContinue)) {
    throw "ListenAddress must belong to this Windows computer."
}
$response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://${ConnectAddress}:${Port}/evaluation"
if ($response.StatusCode -ne 200) { throw "The WSL evaluation server is not ready." }

$matching = @(netsh interface portproxy show v4tov4 | Where-Object {
    $_ -match ("^\s*" + [regex]::Escape($ListenAddress) + "\s+" + $Port + "\s+")
})
if ($matching.Count -gt 0) {
    $fields = $matching[0].Trim() -split "\s+"
    if ($fields[2] -ne $ConnectAddress -or [int]$fields[3] -ne $Port) {
        throw "A different port forwarding rule already exists. It was not changed."
    }
} else {
    $occupied = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object {
        $_.LocalAddress -in @($ListenAddress, "0.0.0.0")
    })
    if ($occupied.Count -gt 0) { throw "The Windows LAN port is already in use." }
}

$ruleName = "VirtualBrowser-Tablet-${ListenAddress}-${Port}"
$rule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if ($rule) {
    $portFilter = $rule | Get-NetFirewallPortFilter
    $addressFilter = $rule | Get-NetFirewallAddressFilter
    if ($portFilter.LocalPort -ne "$Port" -or $portFilter.Protocol -ne "TCP" -or
        $addressFilter.LocalAddress -ne $ListenAddress -or $addressFilter.RemoteAddress -ne "LocalSubnet") {
        throw "An unexpected firewall rule uses this name. It was not changed."
    }
}

if ((Get-Service iphlpsvc).Status -ne "Running") { Start-Service iphlpsvc }
$createdForward = $false
try {
    if ($matching.Count -eq 0) {
        netsh interface portproxy add v4tov4 "listenaddress=$ListenAddress" "listenport=$Port" "connectaddress=$ConnectAddress" "connectport=$Port" protocol=tcp
        if ($LASTEXITCODE -ne 0) { throw "Could not create the port forwarding rule." }
        $createdForward = $true
    }
    if ($rule) {
        Set-NetFirewallRule -Name $ruleName -Enabled True -Action Allow -Direction Inbound -Profile Any | Out-Null
    } else {
        New-NetFirewallRule -Name $ruleName -DisplayName "Virtual Browser tablet evaluation (TCP $Port)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -LocalAddress $ListenAddress -RemoteAddress LocalSubnet -Profile Any -Enabled True | Out-Null
    }
} catch {
    if ($createdForward) {
        netsh interface portproxy delete v4tov4 "listenaddress=$ListenAddress" "listenport=$Port" | Out-Null
    }
    throw
}
Write-Output "Tablet URL: http://${ListenAddress}:${Port}/evaluation"
