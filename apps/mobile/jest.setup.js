// StatusBar batches native updates through the global setImmediate /
// clearImmediate. A handle created while a test fakes timers and cleared by a
// later test under real timers corrupts Node's immediate bookkeeping and the
// worker's event loop spins forever, so StatusBar renders as nothing here and
// never touches the native module. Its props STACK is kept faithful to RN's
// (push on mount, replace on update, pop on unmount; entries shaped like
// createStackEntry) because splashScreen.test.tsx asserts on `_propsStack`
// to pin the overlay's bar-style priority.
jest.mock('react-native/Libraries/Components/StatusBar/StatusBar', () => {
  const React = jest.requireActual('react');
  const createStackEntry = props => {
    const animated = props.animated ?? false;
    return {
      barStyle:
        props.barStyle != null ? { value: props.barStyle, animated } : null,
      hidden:
        props.hidden != null
          ? {
              value: props.hidden,
              animated,
              transition: props.showHideTransition ?? 'fade',
            }
          : null,
    };
  };
  class StatusBar extends React.Component {
    static _propsStack = [];
    static currentHeight = null;
    static setHidden = jest.fn();
    static setBarStyle = jest.fn();
    static setNetworkActivityIndicatorVisible = jest.fn();
    static setBackgroundColor = jest.fn();
    static setTranslucent = jest.fn();
    static pushStackEntry = jest.fn(props => {
      const entry = createStackEntry(props);
      StatusBar._propsStack.push(entry);
      return entry;
    });
    static popStackEntry = jest.fn(entry => {
      const index = StatusBar._propsStack.indexOf(entry);
      if (index !== -1) StatusBar._propsStack.splice(index, 1);
    });
    static replaceStackEntry = jest.fn((entry, props) => {
      const next = createStackEntry(props);
      const index = StatusBar._propsStack.indexOf(entry);
      if (index !== -1) StatusBar._propsStack[index] = next;
      return next;
    });
    _stackEntry = null;
    componentDidMount() {
      this._stackEntry = StatusBar.pushStackEntry(this.props);
    }
    componentDidUpdate() {
      if (this._stackEntry != null) {
        this._stackEntry = StatusBar.replaceStackEntry(
          this._stackEntry,
          this.props,
        );
      }
    }
    componentWillUnmount() {
      if (this._stackEntry != null) StatusBar.popStackEntry(this._stackEntry);
    }
    render() {
      return null;
    }
  }
  return { __esModule: true, default: StatusBar };
});
