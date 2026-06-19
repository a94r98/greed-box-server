with open("f:/Greed Box/mobile/lib/screens/rankings_page.dart", "r", encoding="utf-8") as f:
    for idx, line in enumerate(f):
        if "avatar" in line.lower():
            print(f"Line {idx+1}: {line.strip()}")
