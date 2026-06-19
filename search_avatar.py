import os

def search_files(directory):
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.endswith(".dart"):
                filepath = os.path.join(root, file)
                try:
                    with open(filepath, "r", encoding="utf-8") as f:
                        for idx, line in enumerate(f):
                            if "avatar" in line.lower() and ("image" in line.lower() or "asset" in line.lower() or "network" in line.lower() or "circleavatar" in line.lower()):
                                print(f"{file}:{idx+1}: {line.strip()}")
                except Exception as e:
                    print(f"Error reading {filepath}: {e}")

search_files("f:/Greed Box/mobile/lib")
