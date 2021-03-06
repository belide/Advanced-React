const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getUserId, Context } = require('../utils');
const { randomBytes } = require('crypto');
const { promisify } = require('util');
const mail = require('../mail');
const stripe = require('../stripe');

const mutations = {
  // Signup Mutations
  async signup(parent, args, ctx, info) {
    const password = await bcrypt.hash(args.password, 10);
    const user = await ctx.db.mutation.createUser({
      data: { ...args, password },
    });

    return {
      token: jwt.sign({ userId: user.id }, process.env.APP_SECRET),
      user,
    };
  },

  async signin(parent, { email, password }, ctx, info) {
    const user = await ctx.db.query.user({ where: { email } });
    if (!user) {
      throw new Error(`No such user found for email: ${email}`);
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      throw new Error('Invalid password');
    }
    return {
      token: jwt.sign({ userId: user.id }, process.env.APP_SECRET),
      user,
    };
  },

  // Creation of Post Mutations
  async createItem(parent, args, ctx, info) {
    // TODO - they should be signed in when creating an item for sale
    // TODO: The user should be saved to the item so they can manage it
    return ctx.db.mutation.createItem({ data: { ...args } }, info);
  },

  async deleteItem(parent, args, ctx, info) {
    // TODO - handle auth for deleting an item
    return ctx.db.mutation.deleteItem(
      {
        where: {
          id: args.id,
        },
      },
      info
    );
  },

  async updateItem(parent, args, ctx, info) {
    const updates = { ...args };
    delete updates.id;
    return ctx.db.mutation.updateItem({
      where: { id: args.id },
      data: {
        ...updates,
      },
    });
  },

  // Send password request
  async requestReset(parent, args, ctx, info) {
    // 1. find if there is a user with that email
    const user = await ctx.db.query.user({ where: { email: args.email } });

    if (!user) {
      throw new Error(`No user with the email ${args.email}`);
    }
    // 2. Set a reset token, and a reset date
    const resetToken = (await promisify(randomBytes)(20)).toString('hex');
    const resetTokenExpiry = Date.now() + 3600000; // 1 hour from now
    console.log({ resetToken, resetTokenExpiry });
    const res = await ctx.db.mutation.updateUser({
      where: { email: args.email },
      data: { resetToken, resetTokenExpiry },
    });

    console.log(res);
    // 3. Send them their token via email
    const mailRes = await mail.sendMail({
      from: 'wesbos@gmail.com',
      to: user.email,
      subject: 'Your password reset token',
      // TODO: don't hardcore localhost here
      html: `Here is your reset link: http://localhost:3000/reset?resetToken=${resetToken}`,
    });
    console.log(mailRes);
    return res.updateUser;
  },

  async resetPassword(parent, args, ctx, info) {
    // 1. Check that the passwords match
    if (args.password !== args.confirmPassword) {
      throw new Error('Passwords do not match');
    }

    // 2. Check that this is a legit resetToken
    // 3. Check that it's not expired
    // Note: If we didn't need the user here, we could also use db.exists()
    const [user] = await ctx.db.query.users({
      where: {
        resetToken: args.resetToken,
        resetTokenExpiry_gte: Date.now() - 3600000, // within the last hour
      },
    });

    if (!user) {
      throw new Error('This token is either invalid or expired.');
    }

    // 4. Hash the password
    const password = await bcrypt.hash(args.password, 10);

    // 5. Update the users password
    // clean up the resetToken fields at the same time
    const updatedUser = await ctx.db.mutation.updateUser({
      where: { email: user.email },
      data: {
        password,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    // 6. send back the Auth Payload for the GraphQL request on the client
    return {
      // TODO: This should use sub instead of userId
      token: jwt.sign({ userId: updatedUser.id }, process.env.APP_SECRET),
      user: updatedUser,
    };
  },
  /*
    Add to cart
  */
  async addToCart(parent, args, ctx, info) {
    console.l('Add to cart called');
    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error('You must be signed in to add to cart!');
    }

    // 1. Check if there is a CartItem for this user and item already
    const [existingCartItem] = await ctx.db.query.cartItems({
      where: {
        user: { id: userId },
        item: { id: args.id },
      },
    });

    if (existingCartItem) {
      return ctx.db.mutation.updateCartItem(
        {
          where: { id: existingCartItem.id },
          data: { quantity: existingCartItem.quantity + 1 },
        },
        info
      );
    }

    // Otherwise create a new cartItem
    return ctx.db.mutation.createCartItem(
      {
        data: {
          user: {
            connect: {
              id: userId,
            },
          },
          item: {
            connect: { id: args.id },
          },
        },
      },
      info
    );
  },
  // delete that cart item
  async removeFromCart(parent, args, ctx, info) {
    return ctx.db.mutation.deleteCartItem({
      where: { id: args.id },
    });
  },
  async createOrder(parent, args, ctx, info) {
    const userId = getUserId(ctx);
    const user = await ctx.db.query.user(
      { where: { id: userId } },
      // TODO - can we just pass info here?
      '{ id, name, email, cart { id, quantity, item { title, price, id, description, image } }}'
    );
    // 1. Recalculate the total for the price
    const amount = user.cart.reduce((tally, cartItem) => tally + cartItem.item.price * cartItem.quantity, 0);
    // TODO Error Handling
    // 2.1 Create a Stripe Customer
    const customer = await stripe.customers.create({
      email: user.email,
    });
    // 2.3 Charge the stripe token
    const charge = await stripe.charges.create({
      amount,
      currency: 'usd',
      source: args.token,
    });

    const orderItems = user.cart.map(cartItem => {
      const orderItem = {
        quantity: cartItem.quantity,
        // copy all the item details so it's there forever
        ...cartItem.item,
        item: {
          // realtionship to the Item incase we need it
          connect: { id: cartItem.item.id },
        },
        user: { connect: { id: user.id } },
      };
      // scrub the ID from it because the orderItem will have it's own ID
      delete orderItem.id;
      return orderItem;
    });

    // Create the Order
    const order = await ctx.db.mutation.createOrder({
      data: {
        total: charge.amount,
        charge: charge.id,
        items: {
          // TODO this is going to be create instead
          create: orderItems,
        },
        user: {
          connect: {
            id: user.id,
          },
        },
      },
    });
    console.log('Gonna delete some items');
    // 6. Clean up, clear the users cart adn send back { user, order }
    // Delete the users current cart items
    const cartItemIds = user.cart.map(cartItem => cartItem.id);
    await ctx.db.mutation.deleteManyCartItems({
      where: {
        id_in: cartItemIds,
      },
    });

    // 5. Send the order back to the client
    return order;
    // 4. TODO: Send an email with their order
  },
  async updateUser(parent, args, ctx, info) {
    const userId = getUserId(ctx);
    console.log(userId);
    const updatedUser = await ctx.db.mutation.updateUser({
      data: args,
      where: { id: userId },
    });
    console.log(updatedUser);
    return updatedUser;
  },
};

module.exports = mutations;
