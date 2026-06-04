# Images

Drop image files in this folder. Eleventy copies it straight through, so a file
saved here as `candle-hero.jpg` is served at `/images/candle-hero.jpg`.

## Photos the site is waiting for

The site currently uses labeled placeholders (the striped `.ph` boxes). Each one
below maps to a placeholder you can replace with a real photo:

| Suggested filename            | Where it appears              | Placeholder label        |
| ----------------------------- | ----------------------------- | ------------------------ |
| `candle-hero.jpg`             | Home hero                     | "candle hero photo"      |
| `family-making-candles.jpg`   | Home — "How it started" story | "family making candles"  |
| `maker-jamie.jpg`             | Home — Meet the makers        | "Jamie"                  |
| `maker-tammy.jpg`             | Home — Meet the makers        | "Tammy"                  |
| `maker-mazie.jpg`             | Home — Meet the makers        | "Mazie"                  |
| `maker-tyler.jpg`             | Home — Meet the makers        | "Tyler"                  |
| `maker-night-candle.jpg`      | Maker Night hero              | "maker night candle photo" |

## Swapping a placeholder for a real photo

In the template (`src/index.njk` or `src/maker-night.njk`), replace the
placeholder block, e.g.:

```html
<div class="ph" role="img" aria-label="...">
  <span class="ph-label">candle hero photo</span>
</div>
```

with an image that keeps the placeholder's shape:

```html
<img class="ph" src="/images/candle-hero.jpg"
     alt="A lit hand-poured candle" />
```

The `.ph` class already sets the aspect ratio and rounded corners, so the photo
will sit in the same spot at the same size.
