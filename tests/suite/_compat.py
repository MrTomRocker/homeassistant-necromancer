"""Home Assistant core test helpers, wherever this core checkout keeps them.

Since home-assistant/core#187095 the helpers live in the installable
``pytest_homeassistant`` package; older core checkouts only ship them as
``tests.common``. The suite imports them from here so it runs against both.
"""

from __future__ import annotations

try:
    from pytest_homeassistant.common import (
        MockConfigEntry,
        async_fire_time_changed,
        async_mock_service,
    )
except ImportError:
    from tests.common import (
        MockConfigEntry,
        async_fire_time_changed,
        async_mock_service,
    )

__all__ = ["MockConfigEntry", "async_fire_time_changed", "async_mock_service"]
