#!/usr/bin/env bash
# Archive and upload to TestFlight with the App Store Connect API key in the keychain.
set -euo pipefail
cd "$(dirname "$0")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
key="$work/AuthKey_4KFABSU3DP.p8"
security find-generic-password -s kilo/app-store-connect -w | base64 -d > "$key"
auth=(-allowProvisioningUpdates -authenticationKeyPath "$key" -authenticationKeyID 4KFABSU3DP -authenticationKeyIssuerID 4a0639be-4155-4032-9288-988394504474)
xcodebuild -project Roll.xcodeproj -scheme Roll -configuration Release -destination 'generic/platform=iOS' -archivePath "$work/Roll.xcarchive" archive "${auth[@]}" -quiet
xcodebuild -exportArchive -archivePath "$work/Roll.xcarchive" -exportOptionsPlist ExportOptions.plist -exportPath "$work/export" "${auth[@]}"
