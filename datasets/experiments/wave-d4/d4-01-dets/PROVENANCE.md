# D4-01 detector artifacts — provenance (LINUX-CPU)

These raw paddle detection files were regenerated on Linux CPU (Ubuntu,
D-FINE COCO proxy via `tools/paddle-lab/detect_paddle.py`, ~150–160 ms/frame
inference) because the canonical `runs/` directories are absent on Linux.
They are LINUX-CPU measurements, NOT canonical Mac cascade evidence.

Source videos were downloaded fresh and SHA-256-verified against
`datasets/corpus/recordings.json` / `sources.json`:

| video | sha256 |
| --- | --- |
| DOD_110692879.mp4 | faead33a362caba7ce422d052e49290522b96bd514993a0070a802c7c3679cbf |
| DOD_110695694.mp4 | 916657917f2be72f67717b35bdc0f163915c48a1126731c25f0ae1364121ad13 |
| DOD_110698064.mp4 | 96ae65019c30317c177191c1941225442df8d30c67b554765c13e973870fd394 |

Windows come from the committed `datasets/paddle-bench/runs-wave-a/<case>/window-meta.json`:

| case | video | window (ms) |
| --- | --- | --- |
| wavea-944403-dink | DOD_110695694.mp4 | 20000–23400 |
| wavea-944403-smash | DOD_110695694.mp4 | 2900–4900 |
| wavea-faead-rally | DOD_110692879.mp4 | 12500–14900 |
| wavea-faead-feed | DOD_110692879.mp4 | 32800–34900 |
| wavea-marne-dig | DOD_110698064.mp4 | 12200–14400 |

Held-out cases (wm-dink-01, afn-vic-rally1) were NOT processed.
Files were written directly by the detector and are not hand-edited.
