# Document Scanner (web version)

Straightens and cleans up a phone photo of a handout, entirely in the browser. No install, no server, and the photo is never uploaded.

## Files (keep all three in the same folder)
- `index.html` – the page
- `style.css` – the look
- `script.js` – the scanner

## Run it
Double-click `index.html` (Chrome, Edge, Firefox or Safari).

To put it online with GitHub Pages: upload the three files to a repository, then Settings → Pages → choose the branch.

## Use it
1. Click **Open photo** or drop a photo on the left panel. The page is found automatically and scanned.
2. Pick a style: **Color**, **Gray** or **Black and white**. The result updates at once.
3. If the corners are wrong, drag the four white dots onto the page corners. It re-scans when you let go.
4. Click **PNG**, **JPG** or **PDF** to save.

Untick **Straighten the page** to only clean up the lighting.

## How it works
- **Input:** a phone photo of a handout.
- **Process:** (1) find the page: split the photo into light and dark, take the biggest light area, and use its four extreme points as the corners; (2) straighten it with a perspective transform; (3) estimate the paper's brightness everywhere and divide it out to remove shadows; (4) boost contrast, or threshold to pure black and white.
- **Output:** a clean scan saved as PNG, JPG or a one-page PDF.

If the page edges are cut off by the photo, or the page is not lighter than the surface under it, it says so and you can drag the corners by hand.