import { Component } from 'react';
import withData from '../lib/withData';
import Page from '../components/Page';
import OrderList from '../components/OrderList';

class Orders extends Component {
  render() {
    return (
      <Page>
        <h2>My Orders</h2>
        <OrderList />
      </Page>
    );
  }
}

export default withData(Orders);
