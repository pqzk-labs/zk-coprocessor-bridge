//! Posts a message from Solana to Wormhole Core on devnet.
//! Reads the bridge fee from the Core Bridge account and transfers it.
//! Signs with the emitter PDA and invokes `post_message` with selected finality.

use anchor_lang::prelude::*;
use anchor_lang::AccountDeserialize; // Manual BridgeData decode
use wormhole_anchor_sdk::wormhole;
use wormhole_anchor_sdk::wormhole::program::Wormhole;

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

        require_keys_eq!(
            *ctx.accounts.config.owner,
            ctx.accounts.wormhole_program.key(),
            ZkError::ConfigOwnerMismatch
        );

        let fee: u64 = {
            let data_ref = ctx.accounts.config.try_borrow_data()?;
            let mut data_slice: &[u8] = &*data_ref;
            let bridge_data = wormhole::accounts::BridgeData::try_deserialize(&mut data_slice)
                .map_err(|_| error!(ZkError::BridgeDeserialize))?;
            bridge_data.fee()
        };

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

        let cpi_accounts = wormhole::instructions::PostMessage {
            config:         ctx.accounts.config.to_account_info(),
            message:        ctx.accounts.message.to_account_info(),
            emitter:        ctx.accounts.emitter.to_account_info(),
            sequence:       ctx.accounts.sequence.to_account_info(),
            payer:          ctx.accounts.payer.to_account_info(),
            fee_collector:  ctx.accounts.fee_collector.to_account_info(),
            clock:          ctx.accounts.clock.to_account_info(),
            rent:           ctx.accounts.rent.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };

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

    /// Initializes receipt config.
    pub fn init_receipt_config(
        ctx: Context<InitReceiptConfig>,
        evm_chain: u16,
        emitter: [u8; 32],
    ) -> Result<()> {
        let cfg = &mut ctx.accounts.cfg;
        cfg.admin = ctx.accounts.admin.key();
        cfg.evm_chain = evm_chain;
        cfg.emitter = emitter;
        cfg.bump = ctx.bumps.cfg;
        Ok(())
    }

    /// Records a receipt from a PostedVAA.
    pub fn record_receipt_from_vaa(
        ctx: Context<RecordReceiptFromVaa>,
        emitter: [u8; 32],
        sequence: u64,
    ) -> Result<()> {
        require_keys_eq!(
            *ctx.accounts.posted_vaa.owner,
            ctx.accounts.wormhole_program.key(),
            ZkError::InvalidPostedVaaOwner
        );

        let cfg = &ctx.accounts.cfg;
        require!(emitter == cfg.emitter, ZkError::EmitterAddressMismatch);

        let receipt = &mut ctx.accounts.receipt;
        receipt.emitter = emitter;
        receipt.sequence = sequence;
        receipt.vaa_account = ctx.accounts.posted_vaa.key();
        receipt.posted_timestamp = Clock::get()?.unix_timestamp;
        receipt.bump = ctx.bumps.receipt;

        emit!(ReceiptRecorded {
            emitter,
            sequence,
            vaa: receipt.vaa_account,
        });

        Ok(())
    }

    /// Records a receipt without VAA (admin only).
    pub fn record_receipt_direct(
        ctx: Context<RecordReceiptDirect>,
        emitter: [u8; 32],
        sequence: u64,
    ) -> Result<()> {
        require_keys_eq!(ctx.accounts.cfg.admin, ctx.accounts.admin.key(), ZkError::NotAdmin);

        let r = &mut ctx.accounts.receipt;
        r.emitter = emitter;
        r.sequence = sequence;
        r.vaa_account = Pubkey::default();
        r.posted_timestamp = Clock::get()?.unix_timestamp;
        r.bump = ctx.bumps.receipt;

        emit!(ReceiptRecorded {
            emitter,
            sequence,
            vaa: r.vaa_account,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct PostWormholeMessage<'info> {
    /// CHECK: Points to Wormhole Core Bridge(Config).
    #[account(mut)]
    pub config: AccountInfo<'info>,

    #[account(mut)]
    pub message: Signer<'info>,

    /// CHECK: Verified by Wormhole Core.
    #[account(seeds = [b"emitter"], bump)]
    pub emitter: AccountInfo<'info>,

    /// CHECK: Verified by Wormhole Core.
    #[account(mut)]
    pub sequence: AccountInfo<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Derives from Bridge(Config).
    #[account(mut)]
    pub fee_collector: AccountInfo<'info>,

    pub clock: Sysvar<'info, Clock>,
    pub rent:  Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,

    pub wormhole_program: Program<'info, Wormhole>,
}

#[derive(Accounts)]
pub struct InitReceiptConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + ReceiptConfig::SIZE,
        seeds = [b"cfg"],
        bump
    )]
    pub cfg: Account<'info, ReceiptConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(emitter: [u8; 32], sequence: u64)]
pub struct RecordReceiptFromVaa<'info> {
    #[account(
        mut,
        seeds = [b"cfg"],
        bump = cfg.bump
    )]
    pub cfg: Account<'info, ReceiptConfig>,

    /// CHECK: Owned by Wormhole Core.
    pub posted_vaa: UncheckedAccount<'info>,

    pub wormhole_program: Program<'info, Wormhole>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Receipt::SIZE,
        seeds = [b"receipt", emitter.as_ref(), &sequence.to_be_bytes()],
        bump
    )]
    pub receipt: Account<'info, Receipt>,

    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(emitter: [u8; 32], sequence: u64)]
pub struct RecordReceiptDirect<'info> {
    #[account(
        mut,
        seeds = [b"cfg"],
        bump = cfg.bump
    )]
    pub cfg: Account<'info, ReceiptConfig>,

    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + Receipt::SIZE,
        seeds = [b"receipt", emitter.as_ref(), &sequence.to_be_bytes()],
        bump
    )]
    pub receipt: Account<'info, Receipt>,

    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct ReceiptConfig {
    pub admin: Pubkey,
    pub evm_chain: u16,
    pub emitter: [u8; 32],
    pub bump: u8,
}
impl ReceiptConfig {
    pub const SIZE: usize = 32 + 2 + 32 + 1;
}

#[account]
pub struct Receipt {
    pub emitter: [u8; 32],
    pub sequence: u64,
    pub vaa_account: Pubkey,
    pub posted_timestamp: i64,
    pub bump: u8,
}
impl Receipt {
    pub const SIZE: usize = 32 + 8 + 32 + 8 + 1;
}

#[event]
pub struct ReceiptRecorded {
    pub emitter: [u8; 32],
    pub sequence: u64,
    pub vaa: Pubkey,
}

#[error_code]
pub enum ZkError {
    #[msg("config owner is not the Wormhole Core program")]
    ConfigOwnerMismatch,
    #[msg("failed to deserialize Wormhole BridgeData")]
    BridgeDeserialize,
    #[msg("admin only")] NotAdmin,
    #[msg("invalid owner for PostedVaa account")] InvalidPostedVaaOwner,
    #[msg("emitter address mismatch")] EmitterAddressMismatch,
}
