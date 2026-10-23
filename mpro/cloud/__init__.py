"""MPro Cloud features (hosted service only).

Everything in this package is gated through `entitlements_for(org)` so it can move to the separate MPro Cloud
repository later without touching the modules that call it. Self-hosted installs keep working when a feature here
reports "not available".
"""
