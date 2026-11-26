// Keep the suite independent of a developer's own settings: a ~/.flamingo/config.json that selects the
// KiCadRoutingTools router (or FLAMINGO_ROUTER in the shell) must not change which router the mocked
// autoroute tests exercise.
process.env.FLAMINGO_CONFIG = '/nonexistent/flamingo-config.json';
delete process.env.FLAMINGO_ROUTER;
