# Player review — your repeatable routine

This is the permanent instruction sheet for reviewing new players. The same steps
work every time, forever. Nothing here requires any coding.

## How the two sheets work

- **`new_players_for_review.csv`** — the PIPELINE's sheet. When new players appear in
  the data without a profile, the pipeline itself adds rows here (you'll also get an
  advisory email). **You never edit this file directly on GitHub** — you download it,
  work locally, and upload your answers into the other file.
- **`new_players_reviewed.csv`** — YOUR sheet. Completed rows live here. The pipeline
  reads it on every run and applies your decisions automatically. It never writes to it.

Because each file has exactly one writer, your edits and the pipeline's edits can
never collide.

## The routine, step by step

### 1. You get an email (or just feel like checking)

The email subject is "[cricket-dashboard] N new unmatched active player(s)". You can
also look anytime: the file lives at **github.com/tarutr/cricket-dashboard → `review`
folder → `new_players_for_review.csv`**.

### 2. Download the file

1. Open **github.com/tarutr/cricket-dashboard** in your browser.
2. Click the **`review`** folder, then **`new_players_for_review.csv`**.
3. Click the **download button** (the down-arrow icon, top-right of the file preview,
   tooltip says "Download raw file"). The file lands in your Downloads.

### 3. Fill it in (Excel or Numbers)

Open the downloaded file. Each row is one possible pairing: a database player (left
columns) against one candidate from the Cricinfo sheet (right columns, with the
playercard link for checking). In the **`resolution`** column write:

| write | meaning |
|---|---|
| `YES` | same person — link them. If the right person is a different candidate than the row shows, correct the `sheet_player_id` cell too. |
| `NO` | definitely different people — never propose this pairing again |
| `NONE` | no candidate is right; this player gets no profile |
| *(blank)* | undecided — completely safe, come back later |

`resolution_note` is optional free text. Your decisions are permanent once uploaded.

**Saving:** keep it CSV. Excel: File → Save As → File Format **"CSV UTF-8"**.
Numbers: File → Export To → **CSV**.

### 4. Move completed rows into your sheet

1. Download **`new_players_reviewed.csv`** the same way (step 2).
2. Copy your completed rows (the ones where you wrote YES/NO/NONE) and paste them at
   the **bottom** of `new_players_reviewed.csv`. Keep its single header row at the top.
3. Optionally delete those completed rows from `new_players_for_review.csv` to keep it
   tidy — this is purely cosmetic; the pipeline never re-adds a player that appears in
   either file.
4. Unfinished rows just stay in the for-review file for next time.

### 5. Upload both files back to GitHub

1. On **github.com/tarutr/cricket-dashboard**, click into the **`review`** folder.
2. Click the **"Add file"** button (top right of the file list) → **"Upload files"**.
3. Drag both CSVs from your Downloads into the upload box. Because the names match,
   GitHub replaces the old versions.
4. Scroll down and click the green **"Commit changes"** button. Done.

### 6. That's it — the pipeline does the rest

Within 6 hours (runs happen at 03:47 / 09:47 / 15:47 / 21:47 UTC) your decisions are
applied and the new profiles appear on the site. To make it happen immediately:
**Actions** tab → **"Data pipeline"** in the left sidebar → **"Run workflow"** button
(right side) → green **"Run workflow"**.

If anything you typed is invalid (say, a YES without a sheet_player_id), the run
turns red with a message naming the exact file and line — fix the cell and re-upload.
Nothing breaks in the meantime; the site keeps running on the previous build.

## The big ambiguous file works the same way

`ambiguous_matches.csv` (your original backlog) uses the same `resolution` column and
the same YES/NO/NONE vocabulary. Fill it in at your own pace, upload it via the same
"Add file → Upload files" steps, and the next run applies everything automatically —
there is no separate submission step.

If ever both files disagree about the same player, `new_players_reviewed.csv` wins
over `ambiguous_matches.csv` (and `manual_matches.csv`, a technical file, outranks
both). The run log records any such override.
