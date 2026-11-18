export default {
  // Default is 60000; lowered only to make the repro fast. The default shows the same, just slower.
  onDemandEntries: {
    maxInactiveAge: Number(process.env.MAX_INACTIVE_AGE_MS ?? 5000),
  },

  webpack: (config, { dev, isServer, nextRuntime }) => {
    // WORKAROUND=1: pin the order of the two vendor chunks with distinct cache group priorities.
    if (process.env.WORKAROUND && dev && isServer && nextRuntime === "nodejs") {
      const { cacheGroups } = config.optimization.splitChunks;
      cacheGroups.swcHelpers = {
        ...cacheGroups.vendor,
        test: /[\\/]node_modules[\\/]@swc[\\/]helpers[\\/]/,
        priority: 2,
      };
      cacheGroups.opentelemetryApi = {
        ...cacheGroups.vendor,
        test: /[\\/]node_modules[\\/]@opentelemetry[\\/]api[\\/]/,
        priority: 1,
      };
    }
    return config;
  },
};
