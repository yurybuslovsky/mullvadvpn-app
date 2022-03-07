import styled from 'styled-components';
import { colors } from '../../config.json';
import { messages } from '../../shared/gettext';
import { useAppContext } from '../context';
import { useSelector } from '../redux/store';
import * as AppButton from './AppButton';
import CustomScrollbars from './CustomScrollbars';
import { calculateHeaderBarStyle, DefaultHeaderBar } from './HeaderBar';
import { Container } from './Layout';
import ImageView from './ImageView';
import { Layout } from './Layout';
import { bigText, smallText } from './common-styles';

export const StyledHeader = styled(DefaultHeaderBar)({
  flex: 0,
});

export const StyledCustomScrollbars = styled(CustomScrollbars)({
  flex: 1,
});

export const StyledContainer = styled(Container)({
  paddingTop: '22px',
  minHeight: '100%',
  backgroundColor: colors.darkBlue,
});

export const StyledBody = styled.div({
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  padding: '0 22px',
});

export const StyledFooter = styled.div({
  display: 'flex',
  flexDirection: 'column',
  flex: 0,
  padding: '18px 22px 22px',
});

export const StyledStatusIcon = styled.div({
  alignSelf: 'center',
  width: '60px',
  height: '60px',
  marginBottom: '18px',
});

export const StyledTitle = styled.span(bigText, {
  lineHeight: '38px',
  marginBottom: '8px',
  color: colors.white,
});

export const StyledMessage = styled.span(smallText, {
  marginBottom: '20px',
  color: colors.white,
});

export function DeviceRevokedView() {
  const { leaveRevokedDevice } = useAppContext();
  const tunnelState = useSelector((state) => state.connection.status);

  const Button = tunnelState.state === 'disconnected' ? AppButton.GreenButton : AppButton.RedButton;

  return (
    <Layout>
      <StyledHeader barStyle={calculateHeaderBarStyle(tunnelState)} />
      <StyledCustomScrollbars fillContainer>
        <StyledContainer>
          <StyledBody>
            <StyledStatusIcon>
              <ImageView source="icon-fail" height={60} width={60} />
            </StyledStatusIcon>
            <StyledTitle>
              {messages.pgettext('device-management', 'Device is inactive')}
            </StyledTitle>
            <StyledMessage>
              {messages.pgettext(
                'device-management',
                'You have removed this device from your list of active devices. To connect with this device again, log in.',
              )}
            </StyledMessage>
          </StyledBody>

          <StyledFooter>
            <Button onClick={leaveRevokedDevice}>
              {messages.pgettext('device-management', 'Go to login')}
            </Button>
          </StyledFooter>
        </StyledContainer>
      </StyledCustomScrollbars>
    </Layout>
  );
}
