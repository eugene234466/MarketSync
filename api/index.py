import os
import sys
from pathlib import Path

# Add project root to sys.path so app and models can be imported
root_path = str(Path(__file__).parent.parent)
if root_path not in sys.path:
    sys.path.insert(0, root_path)

from app import app

# Vercel looks for the WSGI application object 'app'
if __name__ == '__main__':
    app.run()
