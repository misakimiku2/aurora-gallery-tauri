$file = "c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src\App.tsx"
$lines = [System.IO.File]::ReadAllLines($file, [System.Text.Encoding]::UTF8)

Write-Host "Current line count: $($lines.Length)"

# 1. Remove external drag useState declarations (lines with isExternalDragging, externalDragItems, externalDragPosition)
$toRemove = @()
for ($i = 0; $i -lt $lines.Length; $i++) {
    $line = $lines[$].Trim()
    if ($line.StartsWith('const [isExternalDragging, setIsExternalDragging]') -or
        $line.StartsWith('const [externalDragItems, setExternalDragItems]') -or
        $line.StartsWith('const [externalDragPosition, setExternalDragPosition]')) {
        $toRemove += $i
        Write-Host "Will remove L$($i+1): $($line.Substring(0, [Math]::Min(80, $line.Length)))"
    }
}

# 2. Remove the useExternalDragDrop call that's in the wrong place (before isDraggingInternal)
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i].Contains('useExternalDragDrop({')) {
        $toRemove += $i
        # Also remove the closing }); lines
        for ($j = $i; $j -lt [Math]::Min($i + 6, $lines.Length); $j++) {
            if ($lines[$j].Contains('}');') {
                $toRemove += $j
                break
            }
        }
        Write-Host "Will remove old useExternalDragDrop call at L$($i+1)"
        break
    }
}

# 3. Remove inline drag handlers (handleExternalDragEnter through end of handleExternalDrop)
$inDragHandlers = $false
$dragHandlerStart = -1
$braceCount = 0
for ($i = 0; $i -lt $lines.Length; $i++) {
    if (-not $inDragHandlers) {
        if ($lines[$i].Trim().StartsWith('const handleExternalDragEnter = (e: React.DragEvent)')) {
            $inDragHandlers = $true
            $dragHandlerStart = $i
            Write-Host "Found inline drag handlers starting at L$($i+1)"
        }
    } else {
        # Count braces to find end of all consecutive drag handler functions
        foreach ($c in $lines[$i].ToCharArray()) { if ($c -eq '{') { $braceCount++ } elseif ($c -eq '}') { $braceCount-- } }
        
        # Check if this line ends a function (};) and braceCount is back to 0
        if ($lines[$i].Trim().EndsWith('};') -and $braceCount -le 0) {
            # Check if next line is another drag handler or blank or something else
            $nextNonEmpty = -1
            for ($k = $i + 1; $k -lt $lines.Length; $k++) {
                if ($lines[$k].Trim().Length -gt 0) { $nextNonEmpty = $k; break }
            }
            if ($nextNonEmpty -ge 0 -and $nextNonEmpty -lt $lines.Length) {
                $nextLine = $lines[$nextNonEmpty].Trim()
                if ($nextLine.StartsWith('const handleExternal') -or $nextLine.StartsWith('//') -or $nextLine.StartsWith('const enter') -or $nextLine.StartsWith('/*')) {
                    continue  # still in drag handlers
                } else {
                    # End of drag handlers
                    for ($k = $dragHandlerStart; $k -le $i; $k++) { $toRemove += $k }
                    Write-Host "Removing inline drag handlers L$($dragHandlerStart+1)-L$($i+1)"
                    $inDragHandlers = $false
                    break
                }
            } else {
                # End of file
                for ($k = $dragHandlerStart; $k -le $i; $k++) { $toRemove += $k }
                Write-Host "Removing inline drag handlers L$($dragHandlerStart+1)-L$($i+1)"
                $inDragHandlers = $false
                break
            }
        }
    }
}

# 4. Remove duplicate handleFileClick (the original one before useFileSearch)
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i].Contains('const handleFileClick = (e: React.MouseEvent, id: string)')) {
        # Find the end of this function
        $braceCount = 0
        $started = $false
        for ($j = $i; $j -lt [Math]::Min($i + 60, $lines.Length); $j++) {
            foreach ($c in $lines[$j].ToCharArray()) { if ($c -eq '{') { $braceCount++ } elseif ($c -eq '}') { $braceCount-- } }
            if ($lines[$j].Trim().EndsWith('};') -and $braceCount -le 0) {
                for ($k = $i; $k -le $j; $k++) { $toRemove += $k }
                Write-Host "Removing original handleFileClick L$($i+1)-L$($j+1)"
                break
            }
        }
        break
    }
}

# 5. Remove duplicate handleClearTagFilter/handleClearAllTags (one-liners that aren't from useTags)
$count = 0
for ($i = 0; $i -lt $lines.Length; $i++) {
    $line = $lines[$i].Trim()
    if (($line.StartsWith('const handleClearTagFilter = ') -and -not $line.Contains('updateActiveTab(prev')) -or
        ($line.StartsWith('const handleClearAllTags = ')) -and $count -lt 2) {
        $toRemove += $i
        $count++
        Write-Host "Removing duplicate clear tag L$($i+1): $line"
    }
}

# Sort in descending order and remove
$toRemove = $toRemove | Sort-Object -Descending | Select-Object -Unique
Write-Host "Total lines to remove: $($toRemove.Count)"

foreach ($idx in $toRemove) {
    if ($idx -ge 0 -and $idx -lt $lines.Length) {
        $lines[$idx] = "___REMOVED___"
    }
}
$lines = $lines | Where-Object { $_ -ne "___REMOVED___" }

Write-Host "New count: $($lines.Length)"

[System.IO.File]::WriteAllLines($file, $lines, [System.Text.Encoding]::UTF8)
Write-Host "Done."
