  it('enables the C language JUCE 9 requires', () => {
    // The version expression is deliberately not pinned to a literal here: it
    // used to read VERSION 0.1.0 while the product shipped 0.5.x, and it now
    // comes from package.json through ${HYBRID_VERSION}. What JUCE 9 needs is
    // the C language, whatever the version looks like.
    expect(CMake).toMatch(/project\(HybridStudio VERSION \S+ LANGUAGES C CXX\)/);
  });

  it('takes the host version from package.json instead of typing it in', () => {
    expect(CMake).toContain('file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../package.json"');
    expect(CMake).toContain('project(HybridStudio VERSION ${HYBRID_VERSION}');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
