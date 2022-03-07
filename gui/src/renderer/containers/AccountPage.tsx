import { connect } from 'react-redux';
import { links } from '../../config.json';
import Account from '../components/Account';

import withAppContext, { IAppContext } from '../context';
import { IHistoryProps, withHistory } from '../lib/history';
import { IReduxState, ReduxDispatch } from '../redux/store';

const mapStateToProps = (state: IReduxState) => ({
  deviceName: state.account.deviceName,
  accountToken: state.account.accountToken,
  accountExpiry: state.account.expiry,
  expiryLocale: state.userInterface.locale,
  isOffline: state.connection.isBlocked,
});
const mapDispatchToProps = (_dispatch: ReduxDispatch, props: IHistoryProps & IAppContext) => {
  return {
    onLogout: () => {
      void props.app.logout();
    },
    onClose: () => {
      props.history.pop();
    },
    onBuyMore: () => props.app.openLinkWithAuth(links.purchase),
    updateAccountData: () => props.app.updateAccountData(),
  };
};

export default withAppContext(withHistory(connect(mapStateToProps, mapDispatchToProps)(Account)));
