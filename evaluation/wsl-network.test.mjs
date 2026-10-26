import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

test(
  "WSL forwarding plan handles LAN/WSL changes and refuses unmanaged rules",
  { skip: !/microsoft/i.test(os.release()) },
  async () => {
    const source = await fs.readFile(
      new URL("./expose-wsl.ps1", import.meta.url),
      "utf8",
    );
    const checks = `
    . { ${source} } -FunctionsOnly
    function Assert($condition, $message) { if (-not $condition) { throw $message } }
    $entries = @(Convert-PortProxyEntries -Lines @('Address Port Address Port', '192.168.1.5 3000 172.20.1.2 3000', '10.0.0.1 8080 10.0.0.2 8080'))
    Assert ($entries.Count -eq 2) 'Parse failed'
    $move = New-ForwardingPlan -Entries $entries -OwnedAddresses @('192.168.1.5') -ListenAddress '192.168.2.5' -ConnectAddress '172.20.2.3' -Port 3000
    Assert ($move.Action -eq 'add' -and $move.Stale.Count -eq 1) 'LAN change failed'
    Assert ($move.Stale[0].ListenPort -eq 3000) 'Other port touched'
    $renew = New-ForwardingPlan -Entries $entries -OwnedAddresses @('192.168.1.5') -ListenAddress '192.168.1.5' -ConnectAddress '172.20.2.3' -Port 3000
    Assert ($renew.Action -eq 'set' -and $renew.Previous.ConnectAddress -eq '172.20.1.2') 'WSL change failed'
    $keep = New-ForwardingPlan -Entries $entries -OwnedAddresses @('192.168.1.5') -ListenAddress '192.168.1.5' -ConnectAddress '172.20.1.2' -Port 3000
    Assert ($keep.Action -eq 'keep') 'Idempotence failed'
    $blocked = $false
    try { New-ForwardingPlan -Entries $entries -OwnedAddresses @() -ListenAddress '192.168.1.5' -ConnectAddress '172.20.2.3' -Port 3000 | Out-Null } catch { $blocked = $true }
    Assert $blocked 'Unmanaged rule was adopted'
    $selected = Select-LanCandidate -Candidates @(
      [pscustomobject]@{Address='100.64.0.1';Metric=1;Physical=$false},
      [pscustomobject]@{Address='192.168.1.5';Metric=20;Physical=$true},
      [pscustomobject]@{Address='169.254.1.1';Metric=0;Physical=$true}
    )
    Assert ($selected.Address -eq '192.168.1.5') 'LAN interface selection failed'
    Write-Output 'network plan tests passed'
  `;
    const encoded = Buffer.from(checks, "utf16le").toString("base64");
    const result = await promisify(execFile)(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    assert.match(result.stdout, /network plan tests passed/);
  },
);
