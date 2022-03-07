import styled from 'styled-components';
import { NavigationScrollbars } from './NavigationBar';
import Selector from './cell/Selector';

export const StyledSelectorContainer = styled.div({
  flex: 0,
});

export const StyledSelectorForFooter = (styled(Selector)({
  marginBottom: 0,
}) as unknown) as new <T>() => Selector<T>;

export const StyledTunnelProtocolContainer = styled(StyledSelectorContainer)({
  marginBottom: '20px',
});

export const StyledNavigationScrollbars = styled(NavigationScrollbars)({
  flex: 1,
});
