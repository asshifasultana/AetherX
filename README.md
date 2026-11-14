# SphereX

## FITS cutouts and aligned display

Open an observation's **Details** row in the search results and choose **View aligned cutout**. The app asks IRSA's IBE for a target-centered SPHEREx MEF cutout, keeps successful cutouts in the server's temporary cache for up to seven days, and leaves failed requests uncached so they can be retried.

The browser reads the science image HDU and reprojects each observation from its FITS celestial WCS onto a common north-up, east-left grid centered on the selected target. The selected square field of view is therefore consistent when switching observations. Rendering uses the image data and display stretch controls; the delivered cutout retains the other FITS HDUs for later processing.

Run the app locally with `npm run dev` from this repository. The local cache lives in the operating system temporary directory and may be cleared by the OS. Vercel function instances also have ephemeral storage, so their cache is reused while an instance remains warm.
