# FITS Cutout Retrieval and Aligned Viewer

This document describes the SphereX FITS cutout work in commits `c01f09f` and `9e619b8`.

## What the feature does

A user can open an observation's **Details** row in the archive results and choose **View aligned cutout**. SphereX requests a target-centered cutout for that one SPHEREx observation, caches the FITS response, and displays its science image on a common sky grid. The display reports the observation date, detector, wavelength range, field of view, and cache status.

## Request and cache flow

1. The **View aligned cutout** action in `frontend/observations-ui.js` passes the selected observation to `frontend/fits-viewer.js`.
2. The browser calls the same-origin `GET /api/cutout` endpoint with the product URL, target RA/Dec, selected field of view, and product revision.
3. `frontend/api/cutout.js` validates the request. It accepts public SPHEREx Level 2 FITS products hosted by IRSA, coordinates in range, and field sizes from 1 to 300 arcminutes.
4. The API requests the cutout from IRSA's IBE endpoint using its `center` and `size` parameters. It retries transient network and server errors up to three times and returns a readable message if IRSA cannot be reached.
5. Successful FITS files up to 24 MiB are cached in the operating system's temporary directory for up to seven days. The cache key includes the product URL, coordinates, field size, and revision. Concurrent identical requests share one in-flight retrieval. Failed requests are not cached.

The endpoint is registered in `frontend/server.mjs` for local development and in `frontend/vercel.json` plus `scripts/build-vercel.mjs` for Vercel deployment. Vercel function storage is ephemeral, so its cache may not persist between warm instances.

## FITS reading and alignment

`frontend/fits-viewer.js` reads the FITS science image and matching `FLAGS` image HDU from the response. It applies `BSCALE`/`BZERO` when reading pixel values and supports FITS big-endian numeric data. The sky mapping supports TAN and TAN-SIP WCS headers.

Each image is sampled onto a shared square grid centered on the selected target, north up and east left, at 6.15 arcseconds per output pixel. The output width is derived from the selected field size. This keeps orientation and scale consistent when observations are switched.

For display, the viewer subtracts the median sky level and applies the selected stretch, color map, contrast, and inversion settings. This changes only rendered pixels; the retrieved FITS file and its science values are not modified.

When **Hide bad pixels** is enabled, the viewer ignores selected unusable quality bits while sampling. It retains overflow and nonlinear pixels to avoid punching holes in bright source cores. The viewer calculates the fraction of the requested field with usable image pixels. If coverage is below 98%, it shows a compact coverage indicator; uncovered pixels use a dark neutral fill.

## User-facing behavior

- Available field sizes are 5′, 10′, 16′, and 25′; the initial setting is 16′. The prime symbol denotes arcminutes, not degrees.
- Changing field size requests a cutout for that size. The prior request is aborted, the previous image is cleared, and the viewer displays a loading message for the requested field.
- The file-opened page redirects from `file://` to `http://127.0.0.1:5173/`, where the local API is available.
- The viewer can be expanded using its fullscreen button.

## Run locally

From the `frontend` directory:

```sh
npm run dev
```

Open <http://127.0.0.1:5173/>. Keep the Node server running while using search and cutout retrieval; opening the HTML file directly cannot provide the API.

## Current limitations

- **View aligned cutout** displays one selected observation at a time. It does not mosaic neighboring observations to fill detector-footprint gaps. Increasing the field of view can therefore reveal a partial footprint; pixels outside that exposure's coverage contain no data.
- The existing “Combine exposures from the same day” control does not yet create a multi-exposure mosaic in this cutout viewer.
- The timeline and playback controls remain marked as coming later; this work does not implement playback, blinking, difference images, or stacking.
- FITS quality masking is a display choice. It does not modify the delivered FITS data or constitute a full scientific quality assessment.

## Verification recorded

The edited JavaScript passed Node syntax checks, `git diff --check` passed, and the local `/api/cutout` endpoint returned HTTP 200 with a cached 16′ FITS response. The full test suite was not run.
