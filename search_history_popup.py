with open("f:/Greed Box/mobile/lib/screens/game_screen.dart", "r", encoding="utf-8") as f:
    lines = f.readlines()

for idx, line in enumerate(lines):
    if "_buildHistoryResultsPopup" in line:
        # Print lines around it
        start = max(0, idx - 2)
        end = min(len(lines), idx + 150)
        for i in range(start, end):
            print(f"{i+1}: {lines[i].strip()}")
        break
