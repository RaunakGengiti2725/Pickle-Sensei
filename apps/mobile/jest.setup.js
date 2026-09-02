// StatusBar batches native updates through the global setImmediate /
// clearImmediate. A handle created while a test fakes timers and cleared by a
// later test under real timers corrupts Node's immediate bookkeeping and the
// worker's event loop spins forever, so StatusBar renders as nothing here and
// its statics are inert. No test asserts on StatusBar output.
jest.mock('react-native/Libraries/Components/StatusBar/StatusBar', () => {
  const React = jest.requireActual('react');
  class StatusBar extends React.Component {
    static currentHeight = null;
    static setHidden = jest.fn();
    static setBarStyle = jest.fn();
    static setNetworkActivityIndicatorVisible = jest.fn();
    static setBackgroundColor = jest.fn();
    static setTranslucent = jest.fn();
    static pushStackEntry = jest.fn(props => props);
    static popStackEntry = jest.fn();
    static replaceStackEntry = jest.fn((_entry, props) => props);
    render() {
      return null;
    }
  }
  return { __esModule: true, default: StatusBar };
});
