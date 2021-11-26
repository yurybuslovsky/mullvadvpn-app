import * as React from 'react';
import { formatDate, hasExpired } from '../../shared/account-expiry';
import { messages } from '../../shared/gettext';
import {
  AccountContainer,
  AccountFooter,
  AccountOutOfTime,
  AccountRow,
  AccountRowLabel,
  AccountRows,
  AccountRowValue,
  DeviceRowValue,
  StyledBuyCreditButton,
  StyledContainer,
  StyledRedeemVoucherButton,
} from './AccountStyles';
import AccountTokenLabel from './AccountTokenLabel';
import * as AppButton from './AppButton';
import { AriaDescribed, AriaDescription, AriaDescriptionGroup } from './AriaGroup';
import { Layout } from './Layout';
import { ModalAlert, ModalAlertType, ModalContainer, ModalMessage } from './Modal';
import { BackBarItem, NavigationBar, NavigationItems, TitleBarItem } from './NavigationBar';
import SettingsHeader, { HeaderTitle } from './SettingsHeader';

import { AccountToken } from '../../shared/daemon-rpc-types';
import { sprintf } from 'sprintf-js';
import { formatMarkdown } from '../markdown-formatter';
import { capitalizeEveryWord } from '../../shared/string-helpers';

interface IProps {
  deviceName?: string;
  accountToken?: AccountToken;
  accountExpiry?: string;
  expiryLocale: string;
  isOffline: boolean;
  onLogout: () => void;
  onClose: () => void;
  onBuyMore: () => Promise<void>;
  updateAccountData: () => void;
}

interface IState {
  showLogoutConfirmationDialog: boolean;
}

export default class Account extends React.Component<IProps, IState> {
  state = { showLogoutConfirmationDialog: false };

  public componentDidMount() {
    this.props.updateAccountData();
  }

  public render() {
    const capitalizedDeviceName = capitalizeEveryWord(this.props.deviceName ?? '');

    return (
      <ModalContainer>
        <Layout>
          <StyledContainer>
            <NavigationBar>
              <NavigationItems>
                <BackBarItem action={this.props.onClose}>
                  {
                    // TRANSLATORS: Back button in navigation bar
                    messages.pgettext('navigation-bar', 'Settings')
                  }
                </BackBarItem>
                <TitleBarItem>
                  {
                    // TRANSLATORS: Title label in navigation bar
                    messages.pgettext('account-view', 'Account')
                  }
                </TitleBarItem>
              </NavigationItems>
            </NavigationBar>

            <AccountContainer>
              <SettingsHeader>
                <HeaderTitle>{messages.pgettext('account-view', 'Account')}</HeaderTitle>
              </SettingsHeader>

              <AccountRows>
                <AccountRow>
                  <AccountRowLabel>
                    {messages.pgettext('account-view', 'Device name')}
                  </AccountRowLabel>
                  <DeviceRowValue>{this.props.deviceName}</DeviceRowValue>
                </AccountRow>

                <AccountRow>
                  <AccountRowLabel>
                    {messages.pgettext('account-view', 'Account number')}
                  </AccountRowLabel>
                  <AccountRowValue
                    as={AccountTokenLabel}
                    accountToken={this.props.accountToken || ''}
                  />
                </AccountRow>

                <AccountRow>
                  <AccountRowLabel>
                    {messages.pgettext('account-view', 'Paid until')}
                  </AccountRowLabel>
                  <FormattedAccountExpiry
                    expiry={this.props.accountExpiry}
                    locale={this.props.expiryLocale}
                  />
                </AccountRow>
              </AccountRows>

              <AccountFooter>
                <AppButton.BlockingButton
                  disabled={this.props.isOffline}
                  onClick={this.props.onBuyMore}>
                  <AriaDescriptionGroup>
                    <AriaDescribed>
                      <StyledBuyCreditButton>
                        <AppButton.Label>{messages.gettext('Buy more credit')}</AppButton.Label>
                        <AriaDescription>
                          <AppButton.Icon
                            source="icon-extLink"
                            height={16}
                            width={16}
                            aria-label={messages.pgettext('accessibility', 'Opens externally')}
                          />
                        </AriaDescription>
                      </StyledBuyCreditButton>
                    </AriaDescribed>
                  </AriaDescriptionGroup>
                </AppButton.BlockingButton>

                <StyledRedeemVoucherButton />

                <AppButton.RedButton onClick={this.onShowLogoutConfirmationDialog}>
                  {messages.pgettext('account-view', 'Log out')}
                </AppButton.RedButton>
              </AccountFooter>
            </AccountContainer>
          </StyledContainer>
        </Layout>

        {this.state.showLogoutConfirmationDialog && (
          <ModalAlert
            type={ModalAlertType.warning}
            buttons={[
              <AppButton.RedButton key="logout" onClick={this.props.onLogout}>
                {
                  // TRANSLATORS: Confirmation button when logging out
                  messages.pgettext('account-view', 'Yes, log out device')
                }
              </AppButton.RedButton>,
              <AppButton.BlueButton key="back" onClick={this.onHideLogoutConfirmationDialog}>
                {messages.gettext('Back')}
              </AppButton.BlueButton>,
            ]}>
            <ModalMessage>
              {formatMarkdown(
                // TRANSLATORS: This is displayed in a warning message before proceeding to log out.
                // TRANSLATORS: The text enclosed in "**" will appear bold.
                // TRANSLATORS: Available placeholders:
                // TRANSLATORS: %(deviceName)s - The name of the currently logged in device.
                sprintf(
                  messages.pgettext(
                    'account-view',
                    'Are you sure you want to log out of **%(deviceName)s**?',
                  ),
                  { deviceName: capitalizedDeviceName },
                ),
              )}
            </ModalMessage>
            <ModalMessage>
              {
                // TRANSLATORS: This is is a further explanation of what happens when logging out.
                messages.pgettext(
                  'account-view',
                  'This will delete all forwarded ports. Local settings will be saved.',
                )
              }
            </ModalMessage>
          </ModalAlert>
        )}
      </ModalContainer>
    );
  }

  private onShowLogoutConfirmationDialog = () => {
    this.setState({ showLogoutConfirmationDialog: true });
  };

  private onHideLogoutConfirmationDialog = () => {
    this.setState({ showLogoutConfirmationDialog: false });
  };
}

function FormattedAccountExpiry(props: { expiry?: string; locale: string }) {
  if (props.expiry) {
    if (hasExpired(props.expiry)) {
      return (
        <AccountOutOfTime>{messages.pgettext('account-view', 'OUT OF TIME')}</AccountOutOfTime>
      );
    } else {
      return <AccountRowValue>{formatDate(props.expiry, props.locale)}</AccountRowValue>;
    }
  } else {
    return (
      <AccountRowValue>
        {messages.pgettext('account-view', 'Currently unavailable')}
      </AccountRowValue>
    );
  }
}
