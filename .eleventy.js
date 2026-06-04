module.exports = function (eleventyConfig) {
  // Copy the stylesheet straight through to the site root.
  eleventyConfig.addPassthroughCopy({ "src/styles.css": "styles.css" });

  // Copy the custom-domain file (GitHub Pages) if present.
  eleventyConfig.addPassthroughCopy("src/CNAME");

  // Copy any real images you drop in later, e.g. src/images/*.
  eleventyConfig.addPassthroughCopy("src/images");

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
