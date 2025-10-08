//! Posts a message from Solana to Wormhole Core on devnet.
//! Reads the bridge fee from the Core Bridge account and transfers it.
//! Signs with the emitter PDA and invokes `post_message` with selected finality.

use anchor_lang::prelude::*;
use anchor_lang::AccountDeserialize; // Manually decodes BridgeData
use wormhole_anchor_sdk::wormhole;

declare_id!("A6BL2woTfWSHHYULjqB9craU67WWPPkF8GnoJR8vG8E3");

#[program]
pub mod zk_coprocessor_program {
    use super::*;

    /// Posts a message to Wormhole Core and pays the bridge fee.
    pub fn post_wormhole_message(
        ctx: Context<PostWormholeMessage>,
        batch_id: u32,
        payload: Vec<u8>,
        finality_flag: u8,
    ) -> Result<()> {
        let fin = if finality_flag == 0 {
            wormhole::types::Finality::Confirmed
        } else {
            wormhole::types::Finality::Finalized
        };

        // Validates Bridge owner equals Wormhole program.
        if *ctx.accounts.config.owner != ctx.accounts.wormhole_program.key() {
            return err!(ZkError::ConfigOwnerMismatch);
        }

        // Reads fee and drops the borrow before CPI.
        let fee: u64 = {
            let data_ref = ctx.accounts.config.try_borrow_data()?;
            let mut data_slice: &[u8] = &*data_ref;
            let bridge_data = wormhole::accounts::BridgeData::try_deserialize(&mut data_slice)
                .map_err(|_| error!(ZkError::BridgeDeserialize))?;
            bridge_data.fee()
        };

        // Transfers fee to fee_collector if needed.
        if fee > 0 {
            let ix = anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.payer.key(),
                &ctx.accounts.fee_collector.key(),
                fee,
            );
            anchor_lang::solana_program::program::invoke(
                &ix,
                &[
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.fee_collector.to_account_info(),
                ],
            )?;
        }

        // Builds CPI context for Wormhole Core post_message.
        let cpi_accounts = wormhole::instructions::PostMessage {
            config:         ctx.accounts.config.to_account_info(),
            message:        ctx.accounts.message.to_account_info(),   // Message account signs externally
            emitter:        ctx.accounts.emitter.to_account_info(),   // Signs with PDA (with_signer)
            sequence:       ctx.accounts.sequence.to_account_info(),  // Sequence PDA for emitter
            payer:          ctx.accounts.payer.to_account_info(),
            fee_collector:  ctx.accounts.fee_collector.to_account_info(),
            clock:          ctx.accounts.clock.to_account_info(),
            rent:           ctx.accounts.rent.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };

        // Makes the emitter PDA a signer.
        let bump = ctx.bumps.emitter;
        let bump_arr = [bump];
        let emitter_seeds: [&[u8]; 2] = [b"emitter", &bump_arr];
        let signer_seeds: [&[&[u8]]; 1] = [&emitter_seeds];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.wormhole_program.to_account_info(),
            cpi_accounts,
            &signer_seeds,
        );

        wormhole::instructions::post_message(cpi_ctx, batch_id, payload, fin)
    }
}

#[derive(Accounts)]
pub struct PostWormholeMessage<'info> {
    /// Holds the Core Bridge config. CHECK: Verifies owner equals wormhole_program at runtime.
    #[account(mut)]
    pub config: AccountInfo<'info>,

    /// Holds the newly created message. Message account signs externally.
    #[account(mut)]
    pub message: Signer<'info>,

    /// Holds the program emitter PDA (seeds=["emitter"]). CHECK: Verified by Core.
    #[account(seeds = [b"emitter"], bump)]
    pub emitter: AccountInfo<'info>,

    /// Holds the Sequence PDA bound to the emitter. CHECK: Verified by Core.
    #[account(mut)]
    pub sequence: AccountInfo<'info>,

    /// Pays fee / rent / CPI.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Holds the Wormhole fee_collector (Core PDA).
    #[account(mut)]
    pub fee_collector: AccountInfo<'info>,

    pub clock: Sysvar<'info, Clock>,
    pub rent:  Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,

    /// Holds the Wormhole Core program (devnet/testnet).
    pub wormhole_program: AccountInfo<'info>,
}

#[error_code]
pub enum ZkError {
    #[msg("config owner is not the Wormhole Core program")]
    ConfigOwnerMismatch,
    #[msg("failed to deserialize Wormhole BridgeData")]
    BridgeDeserialize,
}
