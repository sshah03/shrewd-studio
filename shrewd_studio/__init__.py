"""Shrewd Studio: a local app for building shrewd models."""

__version__ = "0.1.0"

# recent litellm releases trip about 40 harmless pydantic warnings ("... using the `ReadOnly`
# qualifier") as they load; kept out of the terminal and out of job notes
NOISE = r".*using the `ReadOnly` qualifier"

import sys  # noqa: E402

# Popen arguments for Studio's own child processes (workers, pip, dialogs): on Windows a
# console program started by a windowless one opens a console window of its own
NO_WINDOW = {"creationflags": 0x08000000} if sys.platform == "win32" else {}

# children speak UTF-8 on every system: Windows pipes otherwise use the ANSI code page, which
# can't print every document, file name or error
UTF8 = {"PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
