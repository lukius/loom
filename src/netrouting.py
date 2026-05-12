import sys


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    if argv and argv[0] == 'shell':
        from shell import Shell
        Shell().cmdloop()
    else:
        from server import run
        run()


if __name__ == '__main__':
    main()
