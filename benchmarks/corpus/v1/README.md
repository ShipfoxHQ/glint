# Image benchmark corpus

Use these files to test image workers with the same inputs. The full set is
small enough to run on a laptop. It can still expose common image and diff
errors.

## What is included

- two identical images, which should skip pixel comparison;
- small and large visual changes;
- a long page with a change near the bottom;
- transparent images;
- images with different dimensions;
- a noisy image that is harder to compress;
- square and tall PNGs that each open into 16.8 million pixels; and
- a truncated PNG and a non-image file for error handling.

The set defines its inputs and basic results. It does not lock one diff
engine's mask or score. Those details can differ between engines.

## Using the manifest

[`manifest.json`](manifest.json) lists each test case and input file. It also
lists the image size, expected result, and SHA-256 checksum. Paths start from
this directory. Check the file hashes before each test run. This prevents two
runs from using different bytes. Record the engine version and result for each
case ID.

## Privacy

Every file is synthetic. No image comes from Shipfox, Argos, production, or a
customer repository. FFmpeg creates the valid images from fixed colors, grids,
and test patterns. The corrupt files come from the same test inputs or contain
plain text.
