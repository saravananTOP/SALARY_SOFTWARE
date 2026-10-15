$ErrorActionPreference = 'Stop'

$appDirectory = Split-Path -Parent $PSScriptRoot
$outputPath = Join-Path $PSScriptRoot 'Index.html'
$htmlPath = Join-Path $appDirectory 'index.html'
$cssPath = Join-Path $appDirectory 'styles.css'
$jsPath = Join-Path $appDirectory 'app.js'

foreach ($path in @($htmlPath, $cssPath, $jsPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required portal source file not found: $path"
    }
}

$html = [System.IO.File]::ReadAllText($htmlPath)
$css = [System.IO.File]::ReadAllText($cssPath)
$js = [System.IO.File]::ReadAllText($jsPath)
$html = [System.Text.RegularExpressions.Regex]::Replace(
    $html,
    '(?m)^\s*<link rel="stylesheet" href="styles\.css">\s*',
    [System.Text.RegularExpressions.MatchEvaluator]{ param($match) "<style>`n$css`n</style>`n" }
)
$html = [System.Text.RegularExpressions.Regex]::Replace(
    $html,
    '(?m)^\s*<script src="demo-data\.js" defer></script>\s*',
    ''
)
$html = [System.Text.RegularExpressions.Regex]::Replace(
    $html,
    '(?m)^\s*<script src="app\.js" defer></script>\s*',
    ''
)

if ($html -match 'href="styles\.css"|src="(?:demo-data|app)\.js"') {
    throw 'The generated Apps Script page still contains a local asset reference.'
}

$html = $html.Replace('</body>', "<script>`n$js`n</script>`n</body>")
[System.IO.File]::WriteAllText($outputPath, $html, [System.Text.UTF8Encoding]::new($false))
Write-Output "Generated $outputPath"
