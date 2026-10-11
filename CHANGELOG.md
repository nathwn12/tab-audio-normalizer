# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Nothing yet.

## [5.2.0] - 2026-10-02

### Added

- Per-site loudness normalisation to EBU R128, with a 400ms loudness measurement holding audio near a -23.5 to -18 LUFS comfort zone.
- True-peak limiter with a -1 dBTP ceiling, plus the Blast Guard mode for stricter peak protection.
- AudioWorklet processing via content-script injection, with SPA navigation detection and service-worker restart recovery.
- Per-hostname Active toggle that persists across tabs.
- Near-realtime normalizer tuning: band anchor to short-term loudness, wrapped-decrement limiter, hoisted knee, and block-level expansion.
