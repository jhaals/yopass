## Base code borrowed from https://karask.com/retry-powershell-invoke-webrequest/
## Slightly modified to remove things like the file logging.

param (
    [string]$URI,
    [string]$Method = 'GET',
    [string]$SuccessTextContent = 'Healthy',
    [string]$Retries = 1,
    [string]$SecondsDelay = 2,
    [string]$TimeoutSec = 120
)

Write-Output "$Method ""$URI"" Retries: $Retries, SecondsDelay $SecondsDelay, TimeoutSec $TimeoutSec";

Function Req {
    Param(
        [Parameter(Mandatory=$True)]
        [hashtable]$Params,
        [int]$Retries = 1,
        [int]$SecondsDelay = 2
    )

    $Params.Add('UserAgent', 'azagent powershell task')

    $method = $Params['Method']
    $url = $Params['Uri']

    $cmd = { Write-Host "$method $url..." -NoNewline; Invoke-WebRequest @Params }

    $retryCount = 0
    $completed = $false
    $response = $null

    while (-not $completed) {
        try {
            $response = Invoke-Command $cmd -ArgumentList $Params
            if ($response.StatusCode -ne 200) {
                throw "Expecting reponse code 200, was: $($response.StatusCode)"
            }
            $completed = $true
        } catch {
            Write-Output "$(Get-Date -Format G): Request to $url failed. $_"
            if ($retrycount -ge $Retries) {
                Write-Error "Request to $url failed the maximum number of $retryCount times."
                throw
            } else {
                Write-Warning "Request to $url failed. Retrying in $SecondsDelay seconds."
                Start-Sleep $SecondsDelay
                $retrycount++
            }
        }
    }

    Write-Host "OK ($($response.StatusCode))"
    return $response
}

Req -Retries $Retries -SecondsDelay $SecondsDelay -Params @{ 'Method'=$Method;'Uri'=$URI;'TimeoutSec'=$TimeoutSec;'UseBasicParsing'=$true }

Write-Host "Health check validation success."
