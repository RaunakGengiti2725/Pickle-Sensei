/**
 * Attack fixture: a bench script that never exits. Prints one line so the
 * parent can see it started, then blocks forever on a live timer.
 */
console.log("never-exits fixture started; blocking forever");
setInterval(() => {
  /* keep the event loop alive */
}, 1 << 30);
