param(
    [string]$ListenAddress,
    [string]$ConnectAddress,
    [string]$Distribution,
    [string]$InterfaceAlias,
    [ValidateRange(1, 65535)][int]$Port = 3000,
    [switch]$Plan,
    [switch]$FunctionsOnly
)

$ErrorActionPreference = "Stop"

function Convert-PortProxyEntries {
    param([string[]]$Lines)
    foreach ($line in $Lines) {
        if ($line -match '^\s*(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s*$') {
            [pscustomobject]@{ ListenAddress = $matches[1]; ListenPort = [int]$matches[2]; ConnectAddress = $matches[3]; ConnectPort = [int]$matches[4] }
        }
    }
}

function Select-LanCandidate {
    param([object[]]$Candidates)
    $valid = @($Candidates | Where-Object { $_.Address -and $_.Address -notmatch '^(127\.|169\.254\.|0\.)' })
    $physical = @($valid | Where-Object { $_.Physical })
    if ($physical.Count -gt 0) { $valid = $physical }
    $selected = @($valid | Sort-Object Metric, Address | Select-Object -First 1)
    if ($selected.Count -eq 0) { throw "No active LAN address with an IPv4 default gateway was found." }
    return $selected[0]
}

function New-ForwardingPlan {
    param([object[]]$Entries, [string[]]$OwnedAddresses, [string]$ListenAddress, [string]$ConnectAddress, [int]$Port)
    $current = @($Entries | Where-Object { $_.ListenAddress -eq $ListenAddress -and $_.ListenPort -eq $Port })
    if ($current.Count -gt 1) { throw "Ambiguous existing forwarding rules." }
    $action = "add"
    $previous = $null
    if ($current.Count -eq 1) {
        if ($ListenAddress -notin $OwnedAddresses) { throw "An unmanaged forwarding rule already uses this address and port. It was not changed." }
        $previous = $current[0]
        if ($previous.ConnectAddress -eq $ConnectAddress -and $previous.ConnectPort -eq $Port) { $action = "keep" } else { $action = "set" }
    }
    [pscustomobject]@{
        Action = $action
        Previous = $previous
        Stale = @($Entries | Where-Object { $_.ListenPort -eq $Port -and $_.ListenAddress -ne $ListenAddress -and $_.ListenAddress -in $OwnedAddresses })
    }
}

if ($FunctionsOnly) { return }

if (-not $ListenAddress) {
    $candidates = @(foreach ($configuration in (Get-NetIPConfiguration)) {
        if (-not $configuration.IPv4DefaultGateway -or $configuration.NetAdapter.Status -ne "Up") { continue }
        if ($InterfaceAlias -and $configuration.InterfaceAlias -ne $InterfaceAlias) { continue }
        $interface = Get-NetIPInterface -InterfaceIndex $configuration.InterfaceIndex -AddressFamily IPv4
        $metric = (Get-NetRoute -InterfaceIndex $configuration.InterfaceIndex -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" | Measure-Object RouteMetric -Minimum).Minimum
        foreach ($address in $configuration.IPv4Address) {
            [pscustomobject]@{ Address = $address.IPAddress; Alias = $configuration.InterfaceAlias; Metric = [int]$interface.InterfaceMetric + [int]$metric; Physical = [bool]$configuration.NetAdapter.HardwareInterface }
        }
    })
    $selected = Select-LanCandidate -Candidates $candidates
    $ListenAddress = $selected.Address
}
if (-not (Get-NetIPAddress -IPAddress $ListenAddress -ErrorAction SilentlyContinue)) { throw "ListenAddress must belong to this Windows computer." }

if (-not $ConnectAddress) {
    if ($Distribution) { $raw = & wsl.exe --distribution $Distribution --exec hostname -I } else { $raw = & wsl.exe --exec hostname -I }
    if ($LASTEXITCODE -ne 0) { throw "Could not obtain the WSL addresses." }
    $addresses = @($raw -split '\s+' | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Sort-Object @{ Expression = { if ($_ -match '^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)') { 0 } else { 1 } } })
    foreach ($candidate in $addresses) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://${candidate}:${Port}/evaluation/config"
            $configuration = $response.Content | ConvertFrom-Json
            if ($response.StatusCode -eq 200 -and $configuration.urls -is [array] -and $configuration.speedMode) { $ConnectAddress = $candidate; break }
        } catch { }
    }
    if (-not $ConnectAddress) { throw "Start the evaluation server in this WSL distribution before configuring LAN access." }
}
foreach ($address in @($ListenAddress, $ConnectAddress)) {
    if ([System.Net.IPAddress]::Parse($address).AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw "Both addresses must be IPv4 addresses." }
}
$response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://${ConnectAddress}:${Port}/evaluation"
if ($response.StatusCode -ne 200) { throw "The WSL evaluation server is not ready." }

$owned = @(foreach ($rule in (Get-NetFirewallRule -Name "VirtualBrowser-Tablet-*-${Port}" -ErrorAction SilentlyContinue)) {
    if ($rule.Name -notmatch ("^VirtualBrowser-Tablet-(\d+\.\d+\.\d+\.\d+)-" + $Port + '$')) { continue }
    $address = $matches[1]
    $portFilter = $rule | Get-NetFirewallPortFilter
    $addressFilter = $rule | Get-NetFirewallAddressFilter
    if ($portFilter.LocalPort -ne "$Port" -or $portFilter.Protocol -ne "TCP" -or $addressFilter.LocalAddress -ne $address -or $addressFilter.RemoteAddress -ne "LocalSubnet") {
        throw "An unexpected firewall rule uses the application's name. It was not changed."
    }
    [pscustomobject]@{ Address = $address; Name = $rule.Name; Enabled = ($rule.Enabled -eq "True" -and $rule.Action -eq "Allow" -and $rule.Direction -eq "Inbound") }
})
$entries = @(Convert-PortProxyEntries -Lines @(netsh interface portproxy show v4tov4))
$change = New-ForwardingPlan -Entries $entries -OwnedAddresses @($owned | ForEach-Object { $_.Address }) -ListenAddress $ListenAddress -ConnectAddress $ConnectAddress -Port $Port
$ruleName = "VirtualBrowser-Tablet-${ListenAddress}-${Port}"
$currentRule = @($owned | Where-Object { $_.Address -eq $ListenAddress })
$staleRules = @($owned | Where-Object { $_.Address -ne $ListenAddress })
$needsChange = $change.Action -ne "keep" -or $currentRule.Count -ne 1 -or -not $currentRule[0].Enabled -or $staleRules.Count -gt 0 -or (Get-Service iphlpsvc).Status -ne "Running"
$summary = [pscustomobject]@{ ListenAddress = $ListenAddress; ConnectAddress = $ConnectAddress; Port = $Port; Url = "http://${ListenAddress}:${Port}/evaluation"; Action = $change.Action; NeedsChange = [bool]$needsChange; StaleAddresses = @($staleRules | ForEach-Object { $_.Address }) }
if ($Plan) { $summary | ConvertTo-Json -Depth 4 -Compress; return }
if (-not $needsChange) { Write-Output "Tablet URL: $($summary.Url)"; return }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Windows Administrator approval is required to update LAN access." }
if ($change.Action -eq "add") {
    $occupied = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @($ListenAddress, "0.0.0.0") })
    if ($occupied.Count -gt 0) { throw "The Windows LAN port is already in use." }
}
if ((Get-Service iphlpsvc).Status -ne "Running") { Start-Service iphlpsvc }
$createdRule = $false
try {
    if ($change.Action -ne "keep") {
        & netsh interface portproxy $change.Action v4tov4 "listenaddress=$ListenAddress" "listenport=$Port" "connectaddress=$ConnectAddress" "connectport=$Port" protocol=tcp
        if ($LASTEXITCODE -ne 0) { throw "Could not update the port forwarding rule." }
    }
    if ($currentRule.Count -eq 1) {
        Set-NetFirewallRule -Name $ruleName -Enabled True -Action Allow -Direction Inbound -Profile Any | Out-Null
    } else {
        New-NetFirewallRule -Name $ruleName -DisplayName "Virtual Browser tablet evaluation (TCP $Port)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -LocalAddress $ListenAddress -RemoteAddress LocalSubnet -Profile Any -Enabled True | Out-Null
        $createdRule = $true
    }
    $verified = $false
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try { $verified = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $summary.Url).StatusCode -eq 200 } catch { }
        if ($verified) { break }
        Start-Sleep -Milliseconds 300
    }
    if (-not $verified) { throw "The new LAN address did not respond. Keeping the previous configuration." }
} catch {
    if ($createdRule) { Remove-NetFirewallRule -Name $ruleName }
    if ($change.Action -eq "add") { netsh interface portproxy delete v4tov4 "listenaddress=$ListenAddress" "listenport=$Port" | Out-Null }
    if ($change.Action -eq "set") { netsh interface portproxy set v4tov4 "listenaddress=$ListenAddress" "listenport=$Port" "connectaddress=$($change.Previous.ConnectAddress)" "connectport=$($change.Previous.ConnectPort)" protocol=tcp | Out-Null }
    throw
}
foreach ($entry in $change.Stale) {
    netsh interface portproxy delete v4tov4 "listenaddress=$($entry.ListenAddress)" "listenport=$Port" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not remove an old application forwarding rule." }
}
foreach ($rule in $staleRules) { Remove-NetFirewallRule -Name $rule.Name }
Write-Output "Tablet URL: $($summary.Url)"
