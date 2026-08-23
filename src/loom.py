import os


def main():
    from server import run

    host = os.environ.get("LOOM_HOST", "127.0.0.1")
    port = int(os.environ.get("LOOM_PORT", "8000"))
    run(host=host, port=port)


if __name__ == "__main__":
    main()
