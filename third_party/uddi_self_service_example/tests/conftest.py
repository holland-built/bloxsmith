import sys
import os

# Ensure the src package takes precedence over the runner script at the root
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
