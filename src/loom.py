import os


def main():
    from server import run

    port = int(os.environ.get("LOOM_PORT", "8000"))
    run(port=port)


if __name__ == "__main__":
    main()
