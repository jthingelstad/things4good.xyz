module.exports = function (eleventyConfig) {
  // Copy the stylesheet straight through to the site root.
  eleventyConfig.addPassthroughCopy({ "src/styles.css": "styles.css" });

  // Copy the custom-domain file (GitHub Pages) if present.
  eleventyConfig.addPassthroughCopy("src/CNAME");

  // Copy the browser favicon to the site root.
  eleventyConfig.addPassthroughCopy("src/favicon.svg");

  // Copy robots.txt to the site root.
  eleventyConfig.addPassthroughCopy("src/robots.txt");

  // Copy image assets you drop in src/images straight through to /images.
  eleventyConfig.addPassthroughCopy("src/images/**/*.{jpg,jpeg,png,gif,webp,svg,avif,ico}");

  // The images README is repo documentation only — don't publish it.
  eleventyConfig.ignores.add("src/images/README.md");

  return {
    dir: {
      input: "src",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
  };
};
