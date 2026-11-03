"""How a failed job's error reads in the app."""

import errno

from shrewd_studio.worker import plain


def test_a_full_disk_is_said_plainly_whatever_library_hit_it():
    for exc in (OSError(errno.ENOSPC, "No space left on device"),
                RuntimeError("Map Error while serializing: I/O error: No space left on device "
                             "(os error 28)")):
        assert plain(exc).startswith("The disk is full")


def test_other_errors_pass_through():
    assert plain(ValueError("label the pool first")) == "label the pool first"
    assert plain(KeyError()) == "KeyError"
