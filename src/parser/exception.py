class ParsingException(Exception):
    def __init__(self, message: str):
        self.message = message


class ValidationException(Exception):
    def __init__(self, message: str):
        self.message = message
