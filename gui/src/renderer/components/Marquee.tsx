import React from 'react';
import styled from 'styled-components';
import { Scheduler } from '../../shared/scheduler';

const Container = styled.div({
  overflow: 'hidden',
});

const Text = styled.span({}, (props: { overflow: number; alignRight: boolean }) => ({
  display: 'inline-block',
  whiteSpace: 'nowrap',
  willChange: 'transform',
  transform: props.alignRight ? `translate(${-props.overflow}px)` : 'translate(0)',
  transition: `transform linear ${props.overflow * 80}ms`,
}));

interface IMarqueeProps {
  className?: string;
  children?: React.ReactNode;
}

interface IMarqueeState {
  alignRight: boolean;
  // uniqueKey is used to force the Text component to remount to achieve the initial position of the
  // text without using a transition.
  uniqueKey: number;
}

export default class Marquee extends React.Component<IMarqueeProps, IMarqueeState> {
  public state = {
    alignRight: false,
    uniqueKey: 0,
  };

  private textRef = React.createRef<HTMLSpanElement>();
  private scheduler = new Scheduler();

  public componentDidMount() {
    this.startAnimationIfOverflow();
  }

  public componentDidUpdate(prevProps: IMarqueeProps) {
    if (this.props.children !== prevProps.children) {
      this.scheduler.cancel();
      this.setState(
        (state) => ({
          alignRight: false,
          uniqueKey: state.uniqueKey + 1,
        }),
        this.startAnimationIfOverflow,
      );
    }
  }

  public componentWillUnmount() {
    this.scheduler.cancel();
  }

  public render() {
    return (
      <Container>
        <Text
          key={this.state.uniqueKey}
          ref={this.textRef}
          className={this.props.className}
          overflow={this.calculateOverflow()}
          alignRight={this.state.alignRight}
          onTransitionEnd={this.scheduleToggleAlignRight}>
          {this.props.children}
        </Text>
      </Container>
    );
  }

  private startAnimationIfOverflow = () => {
    if (this.calculateOverflow() > 0) {
      this.scheduleToggleAlignRight();
    }
  };

  private scheduleToggleAlignRight = () => {
    this.scheduler.schedule(() => {
      this.setState((state) => ({ alignRight: !state.alignRight }));
    }, 2000);
  };

  private calculateOverflow() {
    const textWidth = this.textRef.current?.offsetWidth ?? 0;
    const parentWidth = this.textRef.current?.parentElement?.offsetWidth ?? 0;
    return textWidth - parentWidth;
  }
}
