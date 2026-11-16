"""Optional local Transformers runtime capability. Imports stay lazy for API-only use."""
import importlib.util


def capabilities():
    def installed(*names):
        return all(importlib.util.find_spec(name) is not None for name in names)

    return {
        'transformers': {
            'available': installed('torch', 'transformers', 'accelerate'),
            'hint': 'Run Setup Local Models to install the Transformers runtime.',
        },
    }
