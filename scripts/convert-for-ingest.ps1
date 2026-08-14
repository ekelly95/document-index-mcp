<#
.SYNOPSIS
Convert the Office formats Document Index MCP cannot read into ones it can.

.DESCRIPTION
Drives the installed Word and PowerPoint through COM — the highest-fidelity
converter that exists for these files, because it is the program that wrote
them. Output lands beside the original; an existing target is never
overwritten, and originals are never modified.

    .doc            ->  .docx
    .ppt  /  .pptx  ->  .pdf  +  <name>-notes.md

Slide decks become a PDF because there is no deck reader: one page per slide,
a PDF bookmark naming each slide, and chart and SmartArt labels surviving as
real text because they were rendered rather than parsed.

The notes file is the half that is easy to forget and expensive to lose. A PDF
export drops speaker notes entirely, and in a lecture deck the notes are often
where the actual teaching is. Measured on a real 28-slide NASA deck: 22 slides
carried notes, and those notes held temperature and orbital figures that appear
nowhere in the slide text, because the slides are artwork. Exporting only the
PDF would have indexed the captions of a lecture and none of its content.

Ingest both files. They stay connected because the notes headings carry the
same slide numbers as the PDF's bookmarks.

.PARAMETER Path
A file, or a folder to sweep.

.PARAMETER Recurse
Walk subdirectories too.

.EXAMPLE
pwsh scripts/convert-for-ingest.ps1 "C:\Users\you\Library\Lectures\week-3.pptx"

.EXAMPLE
pwsh scripts/convert-for-ingest.ps1 "C:\Users\you\Library\Lectures" -Recurse
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path,
    [switch]$Recurse
)

$ErrorActionPreference = "Stop"

# SaveAs format ids: fixed constants of the Office object models.
$wdFormatXMLDocument = 16
$ppSaveAsPDF = 32
$ppPlaceholderBody = 2

if (-not (Test-Path $Path)) { throw "Not found: $Path" }
$item = Get-Item $Path
$wanted = @(".doc", ".ppt", ".pptx")
$files = if ($item.PSIsContainer) {
    Get-ChildItem $Path -File -Recurse:$Recurse | Where-Object { $_.Extension -in $wanted }
} else {
    @($item) | Where-Object { $_.Extension -in $wanted }
}

if (-not $files) {
    Write-Output "Nothing to convert: no .doc, .ppt or .pptx files at $Path"
    return
}

$converted = @()
$skipped = @()
$notes = @()
$warnings = @()

<#
PowerPoint splits a notes paragraph on CR, not CRLF, and returns the lot as one
string. Written out raw that produces a file of bare CRs: one enormous line to
every tool that reads it, with the last word of each paragraph glued to the
first word of the next. Split on either terminator and rejoin as real markdown
paragraphs.
#>
function Format-NotesText {
    param([string]$Text)
    $paragraphs = $Text -split "[`r`n]+" |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_.Length -gt 0 }
    return ($paragraphs -join "`n`n")
}

# The notes body placeholder, or $null. Placeholders(2) is the convention and
# covers every deck seen so far; the shape scan is the fallback for a notes
# page someone rebuilt by hand. The slide-image and slide-number shapes beside
# it are chrome and must never be read as prose.
function Get-NotesText {
    param($Slide)
    try {
        $t = $Slide.NotesPage.Shapes.Placeholders($ppPlaceholderBody).TextFrame.TextRange.Text
        if ($t -and $t.Trim().Length -gt 0) { return $t }
    } catch { }
    try {
        foreach ($shape in $Slide.NotesPage.Shapes) {
            try {
                if ($shape.PlaceholderFormat.Type -ne $ppPlaceholderBody) { continue }
                if (-not $shape.HasTextFrame) { continue }
                $t = $shape.TextFrame.TextRange.Text
                if ($t -and $t.Trim().Length -gt 0) { return $t }
            } catch { }
        }
    } catch { }
    return $null
}

function Get-SlideTitle {
    param($Slide)
    try {
        if ($Slide.Shapes.HasTitle -eq 0) { return $null }
        $t = $Slide.Shapes.Title.TextFrame.TextRange.Text
        if (-not $t) { return $null }
        # Titles wrap across lines in the deck; a markdown heading is one line.
        $t = ($t -split "[`r`n]+" | ForEach-Object { $_.Trim() }) -join " "
        $t = $t.Trim()
        if ($t.Length -eq 0) { return $null }
        return $t
    } catch { return $null }
}

$docs = @($files | Where-Object Extension -eq ".doc")
if ($docs) {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    try {
        foreach ($f in $docs) {
            $target = [System.IO.Path]::ChangeExtension($f.FullName, ".docx")
            if (Test-Path $target) { $skipped += $target; continue }
            $doc = $word.Documents.Open($f.FullName, $false, $true)  # ReadOnly:=true
            try { $doc.SaveAs2($target, $wdFormatXMLDocument) } finally { $doc.Close($false) }
            $converted += $target
        }
    } finally {
        $word.Quit()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
    }
}

$decks = @($files | Where-Object { $_.Extension -in ".ppt", ".pptx" })
if ($decks) {
    $powerpoint = New-Object -ComObject PowerPoint.Application
    try {
        foreach ($f in $decks) {
            $pdfTarget = [System.IO.Path]::ChangeExtension($f.FullName, ".pdf")
            $stem = [System.IO.Path]::GetFileNameWithoutExtension($f.FullName)
            $notesTarget = Join-Path $f.DirectoryName "$stem-notes.md"

            if ((Test-Path $pdfTarget) -and (Test-Path $notesTarget)) {
                $skipped += $pdfTarget
                continue
            }

            # ReadOnly:=true, Untitled:=false, WithWindow:=msoFalse.
            $pres = $powerpoint.Presentations.Open($f.FullName, $true, $false, $false)
            try {
                if (Test-Path $pdfTarget) {
                    $skipped += $pdfTarget
                } else {
                    $pres.SaveCopyAs($pdfTarget, $ppSaveAsPDF)
                    $converted += $pdfTarget
                }

                # A hidden slide is left out of the PDF by PowerPoint, so its
                # notes are left out here too. Indexing them would make the two
                # files disagree about what the deck contains, and a search
                # could then answer from a slide the author chose not to show.
                # Skipping keeps the deck's own numbering in both files -- the
                # PDF bookmarks read "Slide 1", "Slide 3", and so do these
                # headings -- so a citation resolves against either one.
                $hidden = 0
                $lines = New-Object System.Collections.Generic.List[string]
                $body = New-Object System.Collections.Generic.List[string]

                for ($i = 1; $i -le $pres.Slides.Count; $i++) {
                    $slide = $pres.Slides.Item($i)
                    if ($slide.SlideShowTransition.Hidden -ne 0) { $hidden++; continue }

                    $text = Get-NotesText -Slide $slide
                    if (-not $text) { continue }

                    $title = Get-SlideTitle -Slide $slide
                    $heading = if ($title) { "## Slide $i - $title" } else { "## Slide $i" }
                    $body.Add("")
                    $body.Add($heading)
                    $body.Add("")
                    $body.Add((Format-NotesText -Text $text))
                }

                if ($body.Count -eq 0) {
                    $notes += "(no speaker notes) $($f.Name)"
                } elseif (Test-Path $notesTarget) {
                    $skipped += $notesTarget
                } else {
                    $lines.Add("# $stem - speaker notes")
                    $lines.Add("")
                    $lines.Add("Speaker notes from ``$($f.Name)``, which is not readable by " +
                               "Document Index MCP. The slides themselves are in ``$stem.pdf`` " +
                               "beside this file; the slide numbers below match the headings in it.")
                    if ($hidden -gt 0) {
                        $lines.Add("")
                        $lines.Add("Note: the deck has $hidden hidden slide(s). PowerPoint leaves " +
                                   "those out of the PDF, so they are left out here too and " +
                                   "neither file covers them. Slide numbers below are the deck's " +
                                   "own and match the PDF's bookmarks; both therefore skip the " +
                                   "same numbers, and the PDF's page numbers run behind them.")
                    }
                    foreach ($line in $body) { $lines.Add($line) }
                    [System.IO.File]::WriteAllLines($notesTarget, $lines)
                    $converted += $notesTarget
                }

                if ($hidden -gt 0) {
                    $warnings += "$($f.Name): $hidden hidden slide(s) are in neither output; PDF page numbers therefore run behind the deck's slide numbers"
                }
            } finally { $pres.Close() }
        }
    } finally {
        $powerpoint.Quit()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($powerpoint)
    }
}

foreach ($t in $converted) { Write-Output "converted: $t" }
foreach ($t in $skipped)   { Write-Output "skipped (target exists): $t" }
foreach ($t in $notes)     { Write-Output $t }
foreach ($t in $warnings)  { Write-Output "warning: $t" }
Write-Output "$($converted.Count) written, $($skipped.Count) skipped."
